import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { DECISION_DOCUMENT_ROLE_METADATA_KEY } from "@stll/api-contract/decision-document-role";

import {
  DERIVED_REPLAY_METADATA_KEYS,
  PIPELINE_METADATA_POLICY,
  pipelineMetadataPolicy,
} from "../apps/api/src/lib/legal-search/pipeline-metadata-policy";
import { unclassifiedPipelineMetadataWrites } from "./check-case-law-metadata-policy";

const ROOT = path.resolve(import.meta.dir, "..");
const PIPELINE = "apps/api/src/handlers/case-law/ingestion/pipeline";
const files = [
  ...readdirSync(path.join(ROOT, PIPELINE), { recursive: true })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `${PIPELINE}/${name}`),
  "apps/api/src/handlers/case-law/ingestion/citation-scopes.ts",
  "apps/api/src/lib/legal-search/ingestion-normalization.ts",
  "apps/api/src/lib/legal-search/decision-identifier-metadata.ts",
  "apps/api/src/lib/legal-search/metadata-urls.ts",
  "apps/api/src/lib/case-law/decision-text.ts",
];
const keys = new Set(Object.keys(PIPELINE_METADATA_POLICY));
const readSource = (file: string) => {
  const absolute = path.join(ROOT, file);
  return Bun.file(absolute).size === 0
    ? undefined
    : readFileSync(absolute, "utf-8");
};

test("every key introduced by pipeline metadata writers has an explicit replay policy", () => {
  expect(
    unclassifiedPipelineMetadataWrites({
      files,
      readSource,
      classifiedKeys: keys,
    }),
  ).toEqual([]);
});

test("metadata census rejects new literal, imported, alias and loop key writes", () => {
  const file = "fixture.ts";
  const imports = "keys.ts";
  for (const source of [
    "export const write = (metadata: Record<string, unknown>) => ({ ...metadata, unknownField: true });",
    'export const write = (metadata: Record<string, unknown>) => { const copy = { ...metadata }; copy["unknownField"] = true; return copy; };',
    'import { NEW_KEY as added } from "./keys"; export const write = (metadata: Record<string, unknown>) => ({ ...metadata, [added]: true });',
    'export const write = (metadata: Record<string, unknown>) => { for (const key of ["unknownField"]) { metadata[key] = true; } return metadata; };',
  ]) {
    const sources = new Map([
      [file, source],
      [imports, 'export const NEW_KEY = "unknownField";'],
    ]);
    expect(
      unclassifiedPipelineMetadataWrites({
        files: [file],
        readSource: (name) => sources.get(name),
        classifiedKeys: keys,
      }),
    ).toEqual([
      expect.stringContaining(
        "unclassified pipeline metadata key unknownField",
      ),
    ]);
  }
});

test("metadata census refuses unresolved dynamic keys and classification misses panic", () => {
  expect(
    unclassifiedPipelineMetadataWrites({
      files: ["fixture.ts"],
      readSource: () =>
        "export const write = (metadata: Record<string, unknown>, key: string) => { metadata[key] = true; return metadata; };",
      classifiedKeys: keys,
    }),
  ).toEqual([expect.stringContaining("unresolved pipeline metadata write")]);
  expect(() => pipelineMetadataPolicy("unknownField")).toThrow(
    "Unclassified pipeline metadata key: unknownField",
  );
  for (const [key, policy] of Object.entries(PIPELINE_METADATA_POLICY)) {
    expect(
      DERIVED_REPLAY_METADATA_KEYS.some((allowed) => allowed === key),
    ).toBe(policy.type === "derived" && policy.replay === "replace");
  }
});

test("metadata census rejects an unclassified key inserted into the live normalization writer", () => {
  const file = "apps/api/src/lib/legal-search/ingestion-normalization.ts";
  const original = readSource(file);
  if (original === undefined) {
    throw new TypeError("Missing normalization writer");
  }
  const mutated = original.replace(
    "metadata[DECISION_DOCUMENT_ROLE_METADATA_KEY] = result.documentRole;",
    "metadata[DECISION_DOCUMENT_ROLE_METADATA_KEY] = result.documentRole; metadata.unclassifiedPipelineAddition = true;",
  );
  expect(mutated).not.toBe(original);
  expect(
    unclassifiedPipelineMetadataWrites({
      files: [file],
      readSource: (name) => (name === file ? mutated : readSource(name)),
      classifiedKeys: keys,
    }),
  ).toEqual([
    expect.stringContaining(
      "unclassified pipeline metadata key unclassifiedPipelineAddition",
    ),
  ]);
  const missing = new Set(keys);
  missing.delete(DECISION_DOCUMENT_ROLE_METADATA_KEY);
  expect(
    unclassifiedPipelineMetadataWrites({
      files: [file],
      readSource,
      classifiedKeys: missing,
    }).some((finding) =>
      finding.includes(
        `unclassified pipeline metadata key ${DECISION_DOCUMENT_ROLE_METADATA_KEY}`,
      ),
    ),
  ).toBe(true);
});
