import { expect, test } from "bun:test";
import path from "node:path";
import * as v from "valibot";

const apiRoot = path.resolve(import.meta.dirname, "../..");
const bunfigPath = path.join(apiRoot, "bunfig.toml");
const packageJsonPath = path.join(apiRoot, "package.json");

test("only test preloads may import bun:test", async () => {
  const bunfig = v.parse(
    v.object({
      test: v.optional(v.object({ preload: v.optional(v.array(v.string())) })),
    }),
    Bun.TOML.parse(await Bun.file(bunfigPath).text()),
  );
  const testPreloads = bunfig.test?.preload ?? [];
  expect(testPreloads).toContain("./src/tests/statement-ceiling-hooks.ts");

  const packageJson = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    await Bun.file(packageJsonPath).json(),
  );
  const nonTestPreloads = Object.entries(packageJson.scripts)
    .filter(([name]) => !name.startsWith("test"))
    .flatMap(([, command]) =>
      [...command.matchAll(/--preload(?:=|\s+)(\S+)/gu)].map(
        ([, preload]) => preload,
      ),
    )
    .filter((preload): preload is string => preload !== undefined);
  const nonTestModules = ["./src/tests/setup-env.ts", ...nonTestPreloads];

  for (const modulePath of nonTestModules) {
    const source = await Bun.file(path.resolve(apiRoot, modulePath)).text();
    expect(source, modulePath).not.toMatch(
      /(?:from\s+|import\s*\()["']bun:test["']/u,
    );
  }
});
