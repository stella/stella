import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { PUBLIC_LEGISLATION_COUNTRIES } from "@stll/api-contract/legislation-publication";

import { CONTACT_DISPLAY_NAME_MAX_LENGTH } from "@/api/handlers/contacts/list-query";
import { encodeVersionCursor } from "@/api/handlers/entities/version-cursor";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { CORPUS_INDEX_RANKING_MODES } from "@/api/lib/legal-search/corpus-ranking-policy";
import {
  CORPUS_CURSOR_GROUP_TOKEN_CHARS,
  CORPUS_READ_TARGET_IDENTITY_LENGTH,
  decodeCorpusSearchCursor,
  encodeCorpusSearchCursor,
  type CorpusSearchCursor,
} from "@/api/lib/legal-search/corpus-search-cursor";
import { SEARCH_SORTS } from "@/api/lib/legal-search/corpus-search-order";
import { CORPUS_INDEX_GENERATION_MAX_LENGTH } from "@/api/lib/legal-search/index-naming";
import { LIMITS } from "@/api/lib/limits";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { brandPersistedEntityVersionId } from "@/api/lib/safe-id-boundaries";
import { encodeCursor } from "@/api/lib/search/cursor";
import {
  encodeGlobalSearchCursor,
  GLOBAL_SEARCH_RESULT_LIMIT,
} from "@/api/lib/search/pagination";
import { isRecord } from "@/api/lib/type-guards";
import { LAW_COMPAT_TOOL_SET } from "@/api/mcp/compat-law-tools";
import { encodeCompatSearchCursor } from "@/api/mcp/compat-shared";
import {
  encodeReaderCursor,
  readerVersion,
} from "@/api/mcp/decision-reader.logic";
import capabilityCatalog from "@/api/mcp/generated/capability-catalog";
import {
  ALL_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolOutputContract,
} from "@/api/mcp/static-tool-definitions";
import { cursorInput } from "@/api/mcp/tool-utils";

const UUID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const TIMESTAMP = "9999-12-31T23:59:59.999999Z";
const DATE = "9999-12-31";
// The longest finite Number spelling used by the corpus codec's score bound.
const SCORE = -0.0000012345678901234567;
const longestString = <T extends string>(values: readonly T[]): T => {
  const longest = values
    .toSorted((left, right) => right.length - left.length)
    .at(0);
  if (longest === undefined) {
    return panic("A cursor vocabulary must not be empty");
  }
  return longest;
};
const groups = Array.from(
  { length: LIMITS.corpusIndexSearchMaxExcludedGroups },
  (_, index) => String(index).padStart(CORPUS_CURSOR_GROUP_TOKEN_CHARS, "0"),
);

const corpusPosition = {
  dictionary: { type: "dictionary", contentHash: "a".repeat(64) },
  excludedGroups: groups,
  id: UUID,
  score: SCORE,
  sort: longestString(SEARCH_SORTS),
  target: "b".repeat(CORPUS_READ_TARGET_IDENTITY_LENGTH),
  windowStart: 9_999_999_999,
  rankingMode: longestString(CORPUS_INDEX_RANKING_MODES),
} as const satisfies CorpusSearchCursor;

const decisionCursor = encodeCorpusSearchCursor(corpusPosition);
const statutePosition = {
  ...corpusPosition,
  phase: {
    type: "relaxed",
    fingerprint: "c".repeat(64),
    generation: "a".repeat(CORPUS_INDEX_GENERATION_MAX_LENGTH),
    strictWorkTokens: groups,
  },
} as const satisfies CorpusSearchCursor;
const statuteCursor = encodeCorpusSearchCursor(statutePosition);
const corpus = {
  decisions: Object.fromEntries(
    PUBLIC_CASE_LAW_COUNTRIES.map((country) => [country, decisionCursor]),
  ),
  statutes: Object.fromEntries(
    PUBLIC_LEGISLATION_COUNTRIES.map((country) => [country, statuteCursor]),
  ),
};
const timestampCursor = createTimestampIdCursorCodec({
  column: sql`created_at`,
  brandId: (id) => id,
}).encode(TIMESTAMP, UUID);
const idCursor = encodePaginationCursor([UUID]);
const offsetCursor = encodePaginationCursor([Number.MAX_SAFE_INTEGER]);

// These use the same encoders as the handlers: tuple shapes come from the
// owning cursorForItem call, while nested envelopes pass through their codec.
// A registry addition has no fixture by default and fails the census below.
const cursorFixtures: Readonly<Record<string, string>> = {
  "default.search.nextCursor": encodeCompatSearchCursor({
    corpus,
    matter: encodeCursor(SCORE, UUID),
  }),
  "law.search.nextCursor": encodeCompatSearchCursor({ corpus, matter: null }),
  "default.fetch.nextCursor": offsetCursor,
  "law.fetch.nextCursor": offsetCursor,
  "default.list_matters.nextCursor": idCursor,
  "default.search_across_matters.nextCursor": encodeGlobalSearchCursor({
    score: SCORE,
    id: `case-law:${UUID}`,
    seen: GLOBAL_SEARCH_RESULT_LIMIT - 1,
  }),
  "default.search_case_law.nextCursor": encodePaginationCursor(
    Array.from(
      { length: LIMITS.caseLawSearchQueriesMax },
      () => decisionCursor,
    ),
  ),
  "default.read_content_across_matters.nextCursor": offsetCursor,
  "default.read_case_law_citations.nextCursor": idCursor,
  "default.read_case_law_decision_blocks.content.nextCursor":
    encodeReaderCursor({
      decisionId: UUID,
      version: readerVersion([]),
      phase: "provisions",
      offset: Number.MAX_SAFE_INTEGER,
      blockOffset: Number.MAX_SAFE_INTEGER,
      referenceCursor: encodePaginationCursor([
        "9223372036854775807",
        2_147_483_647,
        "a".repeat(LIMITS.decisionReaderProvisionAnchorMaxChars),
      ]),
      batchDigest: readerVersion([]),
    }),
  "default.search_legislation.nextCursor": statuteCursor,
  "default.read_statute.nextCursor": offsetCursor,
  "default.read_provision_history.nextCursor": encodePaginationCursor([
    DATE,
    UUID,
  ]),
  "default.list_templates.nextCursor": idCursor,
  "default.list_documents.nextCursor": timestampCursor,
  "default.read_document.versionsNextCursor": encodeVersionCursor({
    versionNumber: 2_147_483_647,
    id: brandPersistedEntityVersionId(UUID),
  }),
  "default.list_properties.nextCursor": timestampCursor,
  "default.list_contacts.nextCursor": encodePaginationCursor([
    "\u0001".repeat(CONTACT_DISPLAY_NAME_MAX_LENGTH),
    UUID,
  ]),
  "default.list_tasks.nextCursor": encodePaginationCursor([DATE, UUID]),
  "default.list_clauses.nextCursor": timestampCursor,
  "default.list_playbooks.nextCursor": idCursor,
  "default.list_reader_annotations.nextCursor": timestampCursor,
  "default.list_time_entries.nextCursor": encodePaginationCursor([DATE, UUID]),
  "default.list_invoices.nextCursor": timestampCursor,
  "default.list_audit_log.nextCursor": timestampCursor,
  "default.list_capabilities.nextCursor": encodePaginationCursor([
    longestString(capabilityCatalog.map((entry) => entry.id)),
  ]),
};

const outputCursorPaths = (schema: unknown, prefix = ""): string[] => {
  if (!isRecord(schema)) {
    return [];
  }
  const paths: string[] = [];
  if (isRecord(schema["properties"])) {
    for (const [name, child] of Object.entries(schema["properties"])) {
      const path = prefix === "" ? name : `${prefix}.${name}`;
      if (/cursor$/iu.test(name)) {
        paths.push(path);
      }
      paths.push(...outputCursorPaths(child, path));
    }
  }
  if (schema["items"] !== undefined) {
    paths.push(...outputCursorPaths(schema["items"], `${prefix}[]`));
  }
  for (const composition of [
    schema["anyOf"],
    schema["oneOf"],
    schema["allOf"],
  ]) {
    if (Array.isArray(composition)) {
      for (const branch of composition) {
        paths.push(...outputCursorPaths(branch, prefix));
      }
    }
  }
  return [...new Set(paths)];
};

type CursorAcceptanceOptions = {
  schema: v.GenericSchema;
  property: string;
  cursor: string;
};

const acceptsCursor = ({
  schema,
  property,
  cursor,
}: CursorAcceptanceOptions): boolean => {
  const result = v.safeParse(schema, { [property]: cursor });
  return (
    !result.issues?.some(
      (issue) => v.getDotPath(issue)?.split(".").at(0) === property,
    ) &&
    isRecord(result.output) &&
    result.output[property] === cursor
  );
};

describe("every registered pagination envelope fits its own next-call input", () => {
  test("all emitted cursor fields have a real encoder fixture", () => {
    const exercised = new Set<string>();
    const failures: string[] = [];
    for (const definition of ALL_MCP_TOOL_DEFINITIONS) {
      const mode = LAW_COMPAT_TOOL_SET.definitions.some(
        (lawDefinition) => lawDefinition === definition,
      )
        ? "law"
        : "default";
      const output = getStaticMcpToolOutputContract(definition.name, mode);
      if (output === undefined) {
        failures.push(`${mode}.${definition.name}: missing output contract`);
        continue;
      }
      for (const path of outputCursorPaths(output.outputSchema)) {
        const site = `${mode}.${definition.name}.${path}`;
        exercised.add(site);
        const cursor = cursorFixtures[site];
        if (cursor === undefined) {
          failures.push(`${site}: missing real producer fixture`);
          continue;
        }
        const property =
          path === "versionsNextCursor" ? "versions_cursor" : "cursor";
        if (
          !("inputSchemaSource" in definition) ||
          !acceptsCursor({
            schema: definition.inputSchemaSource,
            property,
            cursor,
          })
        ) {
          failures.push(
            `${site}: its ${cursor.length}-character cursor is rejected by ${property}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
    expect([...exercised].toSorted()).toEqual(
      Object.keys(cursorFixtures).toSorted(),
    );
  });

  test("the longest optional corpus segments survive the real encoder", () => {
    expect(decodeCorpusSearchCursor(decisionCursor)).toEqual(corpusPosition);
    expect(decodeCorpusSearchCursor(statuteCursor)).toEqual(statutePosition);
  });

  test("an undersized fixture input fails the same acceptance guard", () => {
    const cursor = encodeCompatSearchCursor({
      corpus,
      matter: encodeCursor(SCORE, UUID),
    });
    expect(cursor.length).toBeGreaterThan(512);
    expect(
      acceptsCursor({
        schema: v.object({
          cursor: cursorInput({
            description: "Fixture cursor",
            maxLength: 512,
          }),
        }),
        property: "cursor",
        cursor,
      }),
    ).toBe(false);
    expect(
      acceptsCursor({
        schema: v.object({
          cursor: cursorInput({
            description: "Fixture cursor",
            maxLength: cursor.length,
          }),
        }),
        property: "cursor",
        cursor,
      }),
    ).toBe(true);
  });
});
