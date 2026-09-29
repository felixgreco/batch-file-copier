import { open } from "node:fs/promises";
import { constants } from "node:fs";

/**
 * Default concurrency. Chosen to be conservative: on most filesystems, more
 * than a handful of concurrent large copies just thrashes the page cache and
 * the I/O scheduler without improving throughput. Callers with many tiny
 * files may want to raise this.
 */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Default per-chunk size in bytes. 64 KiB is a sweet spot for `fs.read`/
 * `fs.write` on Linux and macOS: large enough to amortize syscall overhead,
 * small enough that a single slow file doesn't stall the whole pipeline.
 */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/**
 * Copy a single file from `source` to `destination`, invoking `onProgress`
 * after each chunk is written.
 *
 * We use manual `open`/`read`/`write` loops rather than `fs.copyFile` because
 * `copyFile` gives no progress signal at all, and the whole point of this
 * library is progress reporting. The cost is a few extra syscalls per chunk,
 * which is negligible at the default chunk size.
 *
 * @param {string} source - Absolute or relative path to read from.
 * @param {string} destination - Absolute or relative path to write to.
 * @param {object} [options]
 * @param {number} [options.chunkSize=65536] - Bytes per read/write cycle.
 * @param {(copied: number, total: number) => void} [options.onProgress] - Called after each chunk; `total` is the source file size in bytes, or 0 if the size could not be determined before reading began.
 * @returns {Promise<{copied: number}>} Resolves with the total bytes written.
 * @throws {Error} If the source cannot be opened, the destination cannot be
 *   created, or a read/write fails. On error, a partial destination file may
 *   remain; callers that need atomicity should copy to a temp path and rename.
 */
export async function copyFile(source, destination, options = {}) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  let srcHandle;
  let dstHandle;
  let copied = 0;
  let total = 0;

  try {
    srcHandle = await open(source, constants.O_RDONLY);

    // Stat via the open handle so we don't race with a truncation between stat
    // and open. `srcHandle.stat()` is the handle-bound variant of fstat.
    const stat = await srcHandle.stat();
    total = Number(stat.size) || 0;

    // O_CREAT | O_WRONLY | O_TRUNC: create if missing, error if it's a
    // directory, truncate if it exists. We intentionally do NOT use O_EXCL
    // because overwriting is a legitimate copy semantic and callers who need
    // no-clobber should check before calling.
    dstHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);

    const buffer = Buffer.alloc(chunkSize);
    let bytesRead;

    while ((bytesRead = (await srcHandle.read(buffer, 0, chunkSize, null)).bytesRead) > 0) {
      // Write exactly bytesRead, not chunkSize. The last chunk of a file whose
      // length is not a multiple of chunkSize will be shorter; writing the full
      // buffer would append garbage zeros to the destination.
      await dstHandle.write(buffer, 0, bytesRead, null);
      copied += bytesRead;
      if (onProgress) {
        onProgress(copied, total);
      }
    }

    return { copied };
  } finally {
    // Close in parallel and ignore close errors: a failed close after a
    // successful copy should not mask the real result, and a failed close
    // after a failed copy should not mask the real error. The OS will reclaim
    // descriptors on process exit regardless.
    const closes = [];
    if (dstHandle) closes.push(dstHandle.close().catch(() => {}));
    if (srcHandle) closes.push(srcHandle.close().catch(() => {}));
    await Promise.all(closes);
  }
}

/**
 * Result of a single copy within a batch. Exactly one of `error` or `copied`
 * is meaningful; `copied` is 0 when `error` is set.
 *
 * @typedef {Object} BatchItemResult
 * @property {string} source
 * @property {string} destination
 * @property {number} copied - Bytes written. 0 on failure.
 * @property {Error|null} error - The error that aborted this copy, or null.
 */

/**
 * Copy many files with a bounded concurrency limit.
 *
 * Files are started in array order but complete in whatever order they finish;
 * `onFileProgress` fires as data flows. A failure in one file does NOT abort
 * the others — each file is independent and the batch resolves with a result
 * for every input. This is the right default for, e.g., copying a directory
 * of backups where one corrupt source shouldn't sink the rest.
 *
 * @param {Array<{source: string, destination: string}>} files
 * @param {object} [options]
 * @param {number} [options.concurrency=4] - Max simultaneous copies.
 * @param {number} [options.chunkSize=65536] - Passed through to each `copyFile`.
 * @param {(file: {source: string, destination: string}, copied: number, total: number) => void} [options.onFileProgress]
 * @returns {Promise<BatchItemResult[]>} Results in the SAME order as `files`.
 * @throws {RangeError} If `concurrency` is not a positive integer.
 * @throws {TypeError} If `files` is not an array.
 */
export async function copyBatch(files, options = {}) {
  if (!Array.isArray(files)) {
    throw new TypeError(`files must be an array, got ${typeof files}`);
  }
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError(`concurrency must be a positive integer, got ${concurrency}`);
  }
  const chunkSize = options.chunkSize;
  const onFileProgress = typeof options.onFileProgress === "function" ? options.onFileProgress : null;

  // Pre-allocate results so we can assign by index as tasks finish, preserving
  // input order in the output without a separate sort.
  const results = new Array(files.length);
  let nextIndex = 0;

  async function runOne(index) {
    const file = files[index];
    try {
      const perFileOnProgress = onFileProgress
        ? (copied, total) => onFileProgress(file, copied, total)
        : null;
      const { copied } = await copyFile(file.source, file.destination, {
        chunkSize,
        onProgress: perFileOnProgress,
      });
      results[index] = { source: file.source, destination: file.destination, copied, error: null };
    } catch (err) {
      results[index] = { source: file.source, destination: file.destination, copied: 0, error: err };
    }
  }

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= files.length) return;
      await runOne(index);
    }
  }

  // Spawn `min(concurrency, files.length)` workers. If files.length is 0 this
  // is an empty array and Promise.all resolves immediately, which is the
  // correct behavior for an empty batch.
  const workerCount = Math.min(concurrency, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
