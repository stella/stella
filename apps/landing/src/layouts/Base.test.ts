import { check } from "@astrojs/check";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("base layout keeps compiler syntax valid", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(path.join(root, ".base-check-"));
  try {
    const tsconfig = path.join(directory, "tsconfig.json");
    await Bun.write(
      tsconfig,
      JSON.stringify({
        extends: path.join(root, "tsconfig.json"),
        include: [
          path.join(root, "src/layouts/Base.astro"),
          path.join(root, ".astro/types.d.ts"),
        ],
      }),
    );
    expect(
      await check({
        root,
        tsconfig,
        watch: false,
        minimumSeverity: "error",
        preserveWatchOutput: true,
      }),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
