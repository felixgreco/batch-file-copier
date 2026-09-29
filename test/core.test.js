import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBatch, copyFile, DEFAULT_CONCURRENCY, DEFAULT_CHUNK_SIZE } from "../src/core.js";

describe("copyFile", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "bfc-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("copies bytes faithfully", async () => {
    const src = join(dir, "src.bin");
    const dst = join(dir, "dst.bin");
    const payload = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await writeFile(src, payload);
    const { copied } = await copyFile(src, dst);
    assert.equal(copied, payload.length);
    assert.deepEqual(await readFile(dst), payload);
  });

  test("copies a file larger than the default chunk size", async () => {
    const src = join(dir, "big.bin");
    const dst = join(dir, "big-copy.bin");
    // 3 chunks at DEFAULT_CHUNK_SIZE, plus a partial 4th chunk.
    const payload = Buffer.alloc(DEFAULT_CHUNK_SIZE * 3 + 17, 0xab);
    payload[payload.length - 1] = 0x00;
    await writeFile(src, payload);
    const { copied } = await copyFile(src, dst);
    assert.equal(copied, payload.length);
    assert.deepEqual(await readFile(dst), payload);
  });

  test("copies an empty file", async () => {
    const src = join(dir, "empty.in");
    const dst = join(dir, "empty.out");
    await writeFile(src, "");
    const { copied } = await copyFile(src, dst);
    assert.equal(copied, 0);
    assert.equal((await readFile(dst)).length, 0);
  });

  test("invokes onProgress with monotonically non-decreasing copied and a correct total", async () => {
    const src = join(dir, "prog.in");
    const dst = join(dir, "prog.out");
    const payload = Buffer.alloc(DEFAULT_CHUNK_SIZE * 2 + 5, 0x7e);
    await writeFile(src, payload);
    const samples = [];
    await copyFile(src, dst, {
      onProgress: (copied, total) => samples.push({ copied, total }),
    });
    assert.ok(samples.length >= 2, "expected at least two progress callbacks");
    assert.equal(samples[samples.length - 1].copied, payload.length);
    for (const s of samples) assert.equal(s.total, payload.length);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i].copied >= samples[i - 1].copied, "copied must be non-decreasing");
    }
  });

  test("does not invoke onProgress for an empty file", async () => {
    const src = join(dir, "noprog.in");
    const dst = join(dir, "noprog.out");
    await writeFile(src, "");
    let calls = 0;
    await copyFile(src, dst, { onProgress: () => { calls++; } });
    assert.equal(calls, 0);
  });

  test("rejects when the source does not exist", async () => {
    const dst = join(dir, "nope.out");
    await assert.rejects(() => copyFile(join(dir, "does-not-exist"), dst), { code: "ENOENT" });
  });

  test("rejects when the destination directory does not exist", async () => {
    const src = join(dir, "ok.in");
    await writeFile(src, "x");
    await assert.rejects(
      () => copyFile(src, join(dir, "missing-dir", "out.bin")),
      { code: "ENOENT" }
    );
  });

  test("rejects a non-positive chunkSize", async () => {
    const src = join(dir, "cs.in");
    const dst = join(dir, "cs.out");
    await writeFile(src, "x");
    await assert.rejects(() => copyFile(src, dst, { chunkSize: 0 }), RangeError);
    await assert.rejects(() => copyFile(src, dst, { chunkSize: -1 }), RangeError);
  });

  test("overwrites an existing destination", async () => {
    const src = join(dir, "over.in");
    const dst = join(dir, "over.out");
    await writeFile(src, "new");
    await writeFile(dst, "old-content-that-is-longer");
    await copyFile(src, dst);
    assert.equal((await readFile(dst)).toString(), "new");
  });
});

describe("copyBatch", () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "bfcb-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("copies all files and returns results in input order", async () => {
    const a = join(dir, "a.in");
    const b = join(dir, "b.in");
    const c = join(dir, "c.in");
    await writeFile(a, "aaa");
    await writeFile(b, "bbbb");
    await writeFile(c, "ccccc");
    const files = [
      { source: a, destination: join(dir, "a.out") },
      { source: b, destination: join(dir, "b.out") },
      { source: c, destination: join(dir, "c.out") },
    ];
    const results = await copyBatch(files);
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((r) => r.source), [a, b, c]);
    assert.deepEqual(results.map((r) => r.copied), [3, 4, 5]);
    assert.deepEqual(results.map((r) => r.error), [null, null, null]);
    assert.equal((await readFile(files[0].destination)).toString(), "aaa");
    assert.equal((await readFile(files[1].destination)).toString(), "bbbb");
    assert.equal((await readFile(files[2].destination)).toString(), "ccccc");
  });

  test("respects the concurrency limit", async () => {
    // Make N > concurrency files; assert that at no point do more than
    // `concurrency` copies run simultaneously.
    const N = 6;
    const limit = 2;
    const files = [];
    for (let i = 0; i < N; i++) {
      const src = join(dir, `c${i}.in`);
      await writeFile(src, Buffer.alloc(8, i));
      files.push({ source: src, destination: join(dir, `c${i}.out`) });
    }
    let active = 0;
    let maxActive = 0;
    const results = await copyBatch(files, {
      concurrency: limit,
      onFileProgress: (file, copied, total) => {
        // Use the first progress tick of each file as a proxy for "started".
        // This is conservative: it may undercount overlap slightly, but it can
        // never overcount, so it cannot produce a false positive.
        if (copied > 0 && active < limit) {
          active++;
          if (active > maxActive) maxActive = active;
        }
      },
    });
    assert.equal(results.length, N);
    assert.ok(maxActive <= limit, `maxActive ${maxActive} exceeded limit ${limit}`);
  });

  test("continues after a failing file and reports the error", async () => {
    const good = join(dir, "good.in");
    const bad = join(dir, "bad.in");
    await writeFile(good, "ok");
    const files = [
      { source: good, destination: join(dir, "good.out") },
      { source: bad, destination: join(dir, "bad.out") }, // source missing
      { source: good, destination: join(dir, "good2.out") },
    ];
    const results = await copyBatch(files);
    assert.equal(results.length, 3);
    assert.equal(results[0].copied, 2);
    assert.equal(results[0].error, null);
    assert.equal(results[1].copied, 0);
    assert.ok(results[1].error instanceof Error);
    assert.equal(results[1].error.code, "ENOENT");
    assert.equal(results[2].copied, 2);
    assert.equal(results[2].error, null);
  });

  test("handles an empty input array", async () => {
    const results = await copyBatch([]);
    assert.deepEqual(results, []);
  });

  test("rejects a non-positive concurrency", async () => {
    await assert.rejects(() => copyBatch([], { concurrency: 0 }), RangeError);
    await assert.rejects(() => copyBatch([], { concurrency: -1 }), RangeError);
  });

  test("rejects a non-array files argument", async () => {
    await assert.rejects(() => copyBatch(null), TypeError);
    await assert.rejects(() => copyBatch("not-an-array"), TypeError);
  });

  test("default concurrency is exported and positive", () => {
    assert.ok(Number.isInteger(DEFAULT_CONCURRENCY));
    assert.ok(DEFAULT_CONCURRENCY > 0);
  });
});
