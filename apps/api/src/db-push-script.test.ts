import { describe, expect, test } from "bun:test";

describe("db:push", () => {
  test("applies canonical migrations before schema reconciliation", async () => {
    const manifest: unknown = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("scripts" in manifest) ||
      typeof manifest.scripts !== "object" ||
      manifest.scripts === null ||
      !("db:push" in manifest.scripts)
    ) {
      throw new TypeError("package.json is missing scripts.db:push");
    }
    const script: unknown = manifest.scripts["db:push"];

    expect(typeof script).toBe("string");
    expect(script).toStartWith("bun run db:migrate && ");
    expect(script).toContain("drizzle-kit push");
  });
});
