import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const artifacts = ["release", ":latest", "health-run", "production"];
const reconcile = (receipts: Record<string, boolean>) => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-complete-"));
  const file = path.join(dir, "receipts.json");
  writeFileSync(file, JSON.stringify(receipts));
  const result = Bun.spawnSync([
    "bash",
    path.join(import.meta.dir, "release-complete.sh"),
    file,
  ]);
  rmSync(dir, { recursive: true, force: true });
  return { code: result.exitCode, output: result.stdout.toString() };
};

test("names every missing artifact, including several independent failures", () => {
  expect(reconcile({}).code).toBe(1);
  for (const artifact of artifacts) {
    const receipts = Object.fromEntries(
      artifacts.map((key) => [key, key !== artifact]),
    );
    const result = reconcile(receipts);
    expect(result.code).toBe(1);
    expect(result.output).toBe(
      `::error::Missing release artifact: ${artifact}\n`,
    );
  }
  const allMissing = reconcile({});
  for (const artifact of artifacts) {
    expect(allMissing.output).toContain(
      `Missing release artifact: ${artifact}`,
    );
  }
  expect(
    reconcile(Object.fromEntries(artifacts.map((key) => [key, true]))).code,
  ).toBe(0);
});
