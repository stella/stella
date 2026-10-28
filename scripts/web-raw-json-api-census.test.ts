import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  censusRawJsonApiCalls,
  findRawJsonApiCalls,
} from "./web-raw-json-api-census";

test("rejects a raw JSON request to an apiUrl", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "raw-json-api-census-"));
  const fixture = path.join(directory, "raw-json.ts");
  await writeFile(
    fixture,
    `fetchWithTimeout(apiUrl("/example"), { body: JSON.stringify({ unsafe: true }), method: "POST" });`,
  );

  expect(await findRawJsonApiCalls([fixture], directory)).toEqual([
    'raw-json.ts#"/example"',
  ]);
  await rm(directory, { recursive: true });
});

test("rejects a pre-built JSON request body", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "raw-json-api-census-"));
  const fixture = path.join(directory, "prebuilt.ts");
  await writeFile(
    fixture,
    `const body = JSON.stringify({ unsafe: true });\nfetch(apiUrl("/prebuilt"), { body, method: "POST" });`,
  );
  expect(await findRawJsonApiCalls([fixture], directory)).toEqual([
    'prebuilt.ts#"/prebuilt"',
  ]);
  await rm(directory, { recursive: true });
});

test("reports an allowlisted call that no longer exists", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "raw-json-api-census-"));
  const fixture = path.join(directory, "empty.ts");
  await writeFile(fixture, "export {};\n");
  expect(
    await censusRawJsonApiCalls([fixture], directory, {
      'empty.ts#"/removed"': "Removed stream",
    }),
  ).toEqual({
    violations: [],
    staleAllowlist: ['empty.ts#"/removed"'],
  });
  await rm(directory, { recursive: true });
});
