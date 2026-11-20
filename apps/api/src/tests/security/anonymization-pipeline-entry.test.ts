import { describe, expect, test } from "bun:test";
import path from "node:path";

const apiRoot = path.resolve(import.meta.dir, "../../..");

// Text joined for one pipeline call must be split by the checked helpers in
// `field-markers.ts`. Keeping the pipeline behind one module keeps that true
// for every caller.
const PIPELINE_ENTRY =
  /\brunChatAnonPipeline\b|\.redactText(?:WithCallerDetections)?\(|\bredactStaticEntities\w*\(/u;
// The insolvency register's court decisions are anonymised one paragraph per
// call, nothing joined, so no field boundary exists to split.
const ALLOWED_PIPELINE_CALLERS = [
  "src/handlers/case-law/ingestion/adapters/cz-isir-anonymization.ts",
  "src/mcp/anonymization-core.ts",
];

const isTestSource = (relativePath: string) =>
  relativePath.includes(".test.") ||
  relativePath.startsWith("src/tests/") ||
  relativePath.includes("/__fixtures__/");

describe("anonymization pipeline entry", () => {
  test("only the field-joining module calls the anonymization pipeline", async () => {
    const callers: string[] = [];
    const glob = new Bun.Glob("src/**/*.{ts,tsx}");
    for await (const relativePath of glob.scan({ cwd: apiRoot })) {
      if (isTestSource(relativePath)) {
        continue;
      }
      const source = await Bun.file(path.join(apiRoot, relativePath)).text();
      if (PIPELINE_ENTRY.test(source)) {
        callers.push(relativePath);
      }
    }

    expect(callers.toSorted()).toEqual(ALLOWED_PIPELINE_CALLERS);
  });
});
