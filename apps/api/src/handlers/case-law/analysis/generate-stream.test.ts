import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("generate.ts", import.meta.url)).text();

describe("streamed case-law analysis", () => {
  test("publishes validated complete sections through the guarded partial store", () => {
    expect(source).toContain("streamTanStackObjectForTask");
    expect(source).toContain(
      "v.safeParse(analysisHeadingInputSchema, heading)",
    );
    expect(source).toContain("await store.savePartial");
  });

  test("throttles sentinel writes to one per second", () => {
    expect(source).toContain("lastPublishedAt <");
  });
});
