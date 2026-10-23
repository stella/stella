import { describe, expect, test } from "bun:test";

import { extractTailwindEntryPoints } from "./warm-tailwind-design-systems.ts";

describe("Tailwind design-system entry-point extraction", () => {
  test("deduplicates uses while preserving the first matching file scope", () => {
    const config = {
      settings: {
        tailwindcss: {
          entryPoint: [
            { files: "apps/web/**", use: "apps/web/app.css" },
            { files: "packages/ui/**", use: "apps/web/app.css" },
            { files: "apps/landing/**", use: "apps/landing/global.css" },
          ],
        },
      },
    };

    expect(extractTailwindEntryPoints(config)).toEqual([
      { files: "apps/web/**", use: "apps/web/app.css" },
      { files: "apps/landing/**", use: "apps/landing/global.css" },
    ]);
  });

  test("rejects a malformed entry-point row", () => {
    const config = {
      settings: { tailwindcss: { entryPoint: [{ files: "apps/web/**" }] } },
    };

    expect(() => extractTailwindEntryPoints(config)).toThrow(
      "tailwindcss entryPoint rows require files and use",
    );
  });
});
