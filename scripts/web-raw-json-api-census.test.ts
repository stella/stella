import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findRawJsonApiCalls } from "./web-raw-json-api-census";

test("rejects a raw JSON request to an apiUrl", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "raw-json-api-census-"));
  const fixture = path.join(directory, "raw-json.ts");
  await writeFile(
    fixture,
    `fetchWithTimeout(apiUrl("/example"), { body: JSON.stringify({ unsafe: true }), method: "POST" });`,
  );

  expect(await findRawJsonApiCalls([fixture], directory)).toEqual([
    "raw-json.ts",
  ]);
  await rm(directory, { recursive: true });
});
