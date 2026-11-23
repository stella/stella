// Test fixture: a worker whose resident memory keeps growing, 16 MiB every
// 10 ms, up to 1 GiB, then exits cleanly. Every page is written, so the
// memory is resident and not just reserved.
const CHUNK_BYTES = 16 * 1024 * 1024;
const LIMIT_BYTES = 1024 * 1024 * 1024;
const held: Uint8Array[] = [];
for (let total = 0; total < LIMIT_BYTES; total += CHUNK_BYTES) {
  held.push(new Uint8Array(CHUNK_BYTES).fill(1));
  await Bun.sleep(10);
}
process.stdout.write(String(held.length));
