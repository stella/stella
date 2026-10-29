import { convertToTsx } from "@astrojs/astro2tsx";
import { expect, test } from "bun:test";

test("base layout keeps compiler syntax valid", async () => {
  const source = await Bun.file(new URL("Base.astro", import.meta.url)).text();
  const result = convertToTsx(source, { filename: "Base.astro" });
  expect(result.diagnostics).toEqual([]);
  expect(result.hasParseErrors).toBe(false);
});
