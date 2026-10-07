# batch-file-copier

Copies many files at once with a bounded concurrency limit and per-file progress callbacks. Node.js, ESM, zero dependencies.

## Usage

```js
import { copyBatch, copyFile } from "batch-file-copier";
import { writeFile, mkdir } from "node:fs/promises";

// Set up example inputs.
await mkdir("./archive", { recursive: true });
await writeFile("./a.log", "a");
await writeFile("./b.log", "bb");

// One file, with progress.
await copyFile("./a.log", "./archive/a.log", {
  onProgress: (copied, total) => console.log(`${copied}/${total}`),
});

// Many files, at most 4 at a time.
const results = await copyBatch(
  [
    { source: "./a.log", destination: "./archive/a.log" },
    { source: "./b.log", destination: "./archive/b.log" },
  ],
  {
    concurrency: 4,
    onFileProgress: (file, copied, total) => {
      console.log(`${file.destination}: ${copied}/${total}`);
    },
  }
);
for (const r of results) {
  if (r.error) console.error(`${r.source} failed:`, r.error.message);
}
```

## Exports

- `copyFile(source, destination, options?) → Promise<{ copied: number }>`
  - `options.chunkSize` (default `65536`) — bytes per read/write cycle.
  - `options.onProgress(copied, total)` — called after each chunk is written. `total` is the source file size in bytes.
- `copyBatch(files, options?) → Promise<Array<{ source, destination, copied, error }>>`
  - `files` — array of `{ source, destination }`.
  - `options.concurrency` (default `4`) — max simultaneous copies.
  - `options.chunkSize` — passed through to each `copyFile`.
  - `options.onFileProgress(file, copied, total)` — per-file progress.
  - Results are in the same order as `files`. A failing file yields `copied: 0` and a non-null `error`; other files still run.
- `DEFAULT_CONCURRENCY` (number, `4`), `DEFAULT_CHUNK_SIZE` (number, `65536`).

## Why

`fs.cp` and `fs.copyFile` copy a file with no progress signal. When you're copying gigabyte-sized logs over a slow link, "is it stuck?" is a real question. This library gives you a per-chunk callback so you can render a real progress bar, and a concurrency limit so that copying 10,000 small files doesn't fork 10,000 file descriptors.

The trade-off: we use manual `open`/`read`/`write` loops instead of the kernel's `copy_file_range` fast path, so pure throughput is lower than `fs.copyFile`. You buy progress and concurrency with syscall overhead.

## Edges you will hit

- **Partial files on failure.** If a copy fails mid-stream, the destination file is left in place with whatever was written. This library does not clean it up. If you need atomicity, copy to a temp path in the same directory and `rename` on success.
- **Overwrite, not clobber-protect.** `copyFile` truncates an existing destination. There is no `no-clobber` option; check first if you need it.
- **One file's failure does not stop the batch.** `copyBatch` always resolves; per-file errors are in the `error` field of each result. It never rejects due to a copy failure (only due to bad arguments).
- **`onProgress` total is the size at open time.** If the source grows or shrinks during the copy, `total` is stale and `copied` may exceed it.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

## Limitations

Values are coerced to floats, so very large integers lose precision. If you need
exact integer aggregates over a window, this is the wrong tool.

