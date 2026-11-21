import { expect, test } from "bun:test";
import path from "node:path";

const projectionPath = path.join(
  import.meta.dirname,
  "decision-reader-projections.ts",
);

test("decision reader output projections bundle without server modules", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  const result = await Bun.build({
    root: repoRoot,
    entrypoints: [projectionPath],
    target: "browser",
    metafile: true,
  });
  expect(result.success).toBe(true);
  expect(result.logs).toEqual([]);
  expect(result.metafile).toBeDefined();
  if (result.metafile === undefined) {
    throw new TypeError("Projection build must report reachable modules");
  }
  const apiRoot = path.resolve(import.meta.dirname, "../..");
  const inputs = Object.keys(result.metafile.inputs).map((input) =>
    path.resolve(input),
  );
  expect(inputs).toContain(projectionPath);
  const apiInputs = inputs.filter((input) =>
    input.startsWith(`${apiRoot}${path.sep}`),
  );
  expect(apiInputs).toEqual([projectionPath]);
});
