import { describe, expect, test } from "bun:test";

import { checkWorkerOnlyGroups } from "./bundle-baseline";

describe("worker-only bundle groups", () => {
  test.each(["vendor-anonymize-data", "wasm-vendor"] as const)(
    "fails when %s contributes bytes to a main-thread chunk",
    (group) => {
      const lines: string[] = [];
      const sizes = {
        "vendor-anonymize-data": 0,
        "wasm-vendor": 0,
        [group]: 4096,
      };

      expect(
        checkWorkerOnlyGroups(sizes, (line) => {
          lines.push(line);
        }),
      ).toBe(1);
      expect(lines).toEqual([
        expect.stringContaining(`Worker-only bundle group: ${group}`),
      ]);
      expect(lines[0]).toContain(
        "apps/web/src/workers/anonymize-chat-worker.ts",
      );
      expect(lines[0]).toContain(
        "Keep this group out of the main build's manualChunks",
      );
    },
  );

  test("passes when both worker-only groups stay out of main-thread chunks", () => {
    const lines: string[] = [];

    expect(
      checkWorkerOnlyGroups(
        { "vendor-anonymize-data": 0, "wasm-vendor": 0 },
        (line) => {
          lines.push(line);
        },
      ),
    ).toBe(0);
    expect(lines).toEqual([]);
  });
});
