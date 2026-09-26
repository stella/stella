import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { CORPUS_STORAGE_MODES } from "@/api/lib/corpus-storage-mode";
import {
  canonicalLegislationAstSource,
  canonicalLegislationTextSource,
} from "@/api/lib/legal-search/legislation-canonical-source";

const API_SRC = nodePath.resolve(import.meta.dir, "../..");
const STORED_KEY = "legislation/cze/2012/89/payload.zst";

describe("canonical legislation payload source", () => {
  test.each([...CORPUS_STORAGE_MODES])(
    "object storage serves a keyed payload exactly when storage is on (%s)",
    (mode) => {
      const expectedKeyed =
        mode === "off"
          ? { type: "database" }
          : { type: "object_storage", key: STORED_KEY };

      expect(
        canonicalLegislationAstSource({ astS3Key: STORED_KEY }, mode),
      ).toEqual(expectedKeyed);
      expect(
        canonicalLegislationTextSource({ textS3Key: STORED_KEY }, mode),
      ).toEqual(expectedKeyed);
      expect(canonicalLegislationAstSource({ astS3Key: null }, mode)).toEqual({
        type: "database",
      });
      expect(canonicalLegislationTextSource({ textS3Key: null }, mode)).toEqual(
        { type: "database" },
      );
    },
  );
});

/**
 * Reading a version's AST columns directly is how a second source predicate
 * starts. Readers select through `versionAstColumns` and parse through
 * `readVersionAst`; the only other file is the ingestion write, which plans
 * the object write rather than choosing where to read from.
 */
const LEGISLATION_AST_COLUMN_OWNERS = [
  "handlers/legislation/ingestion.ts",
  "lib/legal-search/legislation-version-blocks.ts",
] as const;

const LEGISLATION_AST_COLUMN_READ =
  /legislationDocuments\.(?:astS3Key|documentAst)\b|query\.legislationDocuments\b[\s\S]*\b(?:astS3Key|documentAst)\s*:\s*true/u;

test("only the owners read a legislation version's AST columns", async () => {
  const readers: string[] = [];
  for await (const file of new Glob("**/*.{ts,tsx}").scan(API_SRC)) {
    if (/\.test\.tsx?$/u.test(file)) {
      continue;
    }
    const source = await Bun.file(nodePath.join(API_SRC, file)).text();
    if (LEGISLATION_AST_COLUMN_READ.test(source)) {
      readers.push(file);
    }
  }

  expect(readers.toSorted()).toEqual([...LEGISLATION_AST_COLUMN_OWNERS]);
});
