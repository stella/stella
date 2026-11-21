import { panic } from "better-result";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("child peak memory reports bytes for a known resident allocation", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--smol",
      fileURLToPath(
        new URL("test-fixtures/process-memory-calibration.ts", import.meta.url),
      ),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit, stderr).toBe(0);
  const receipt: unknown = JSON.parse(stdout);
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    !("baselineBytes" in receipt) ||
    typeof receipt.baselineBytes !== "number" ||
    !("peakBytes" in receipt) ||
    typeof receipt.peakBytes !== "number" ||
    !("allocationBytes" in receipt) ||
    typeof receipt.allocationBytes !== "number" ||
    !("touchedPages" in receipt) ||
    typeof receipt.touchedPages !== "number"
  ) {
    panic("Memory calibration receipt is invalid");
  }
  expect(receipt.baselineBytes).toBeLessThan(128 * 1024 * 1024);
  expect(receipt.allocationBytes).toBe(128 * 1024 * 1024);
  expect(receipt.touchedPages).toBe(receipt.allocationBytes / 4096);
  const increase = receipt.peakBytes - receipt.baselineBytes;
  expect(increase).toBeGreaterThan(receipt.allocationBytes / 2);
  expect(increase).toBeLessThan(receipt.allocationBytes * 2);
});
