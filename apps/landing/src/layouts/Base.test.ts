import { check } from "@astrojs/check";
import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("base layout keeps compiler syntax valid", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(path.join(root, ".base-check-"));
  const layout = path.join(directory, "src/layouts/Base.astro");
  try {
    // Relative imports resolve against a complete, isolated source tree.
    await cp(new URL("../", import.meta.url), path.join(directory, "src"), {
      recursive: true,
    });
    await Bun.write(layout, Bun.file(new URL("Base.astro", import.meta.url)));
    const tsconfig = path.join(directory, "tsconfig.json");
    await Bun.write(
      tsconfig,
      JSON.stringify({
        extends: path.join(root, "tsconfig.json"),
        include: [layout, path.join(root, ".astro/types.d.ts")],
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
