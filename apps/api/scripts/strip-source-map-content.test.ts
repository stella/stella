import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { stripSourceMapContent } from "./strip-source-map-content";

const root = mkdtempSync(path.join(tmpdir(), "strip-source-map-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const buildThrowingBundle = async (name: string) => {
  const sourceDir = path.join(root, name, "src");
  const outDir = path.join(root, name, "out");
  await Bun.write(
    path.join(sourceDir, "fail.ts"),
    'export const fail = (): never => {\n  // keeps the throw on line 3\n  throw new Error("mapped");\n};\n',
  );
  await Bun.write(
    path.join(sourceDir, "entry.ts"),
    'import { fail } from "./fail";\ntry {\n  fail();\n} catch (error) {\n  console.log(error instanceof Error ? error.stack : "");\n}\n',
  );
  const built = await Bun.build({
    entrypoints: [path.join(sourceDir, "entry.ts")],
    outdir: outDir,
    target: "bun",
    sourcemap: "linked",
    publicPath: `${outDir}/`,
  });
  expect(built.success).toBe(true);
  return { bundle: path.join(outDir, "entry.js"), sourceDir };
};

// Run from an unrelated directory, like the image does from /app/apps/api.
const stackOf = async (bundle: string) => {
  const child = Bun.spawn(["bun", "--no-env-file", bundle], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(await child.exited).toBe(0);
  return { stdout, stderr };
};

describe("stripSourceMapContent", () => {
  test("drops the embedded source text and keeps frames on source lines", async () => {
    const { bundle, sourceDir } = await buildThrowingBundle("mapped");
    const before = await Bun.file(`${bundle}.map`).json();
    expect(before.sourcesContent.some(Boolean)).toBe(true);

    await stripSourceMapContent(`${bundle}.map`);

    const after = await Bun.file(`${bundle}.map`).json();
    expect(after.sourcesContent).toEqual(after.sources.map(() => null));
    expect(after.mappings).toBe(before.mappings);
    expect(after.sources).toEqual(before.sources);
    const { stdout, stderr } = await stackOf(bundle);
    expect(stderr).not.toContain("Could not decode sourcemap");
    expect(stdout).toContain(`${path.join(sourceDir, "fail.ts")}:3:`);
  });

  test("refuses a file that is not a source map", async () => {
    const notAMap = path.join(root, "bundle.js.map");
    writeFileSync(notAMap, JSON.stringify({ version: 3 }));
    const rejection = await rejectionOf(stripSourceMapContent(notAMap));
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toContain(
      "build the bundle with --sourcemap=linked",
    );
  });
});
