/**
 * A decision's references project to exactly the rows the row builder wrote
 * before references were derived apart from storage.
 *
 * `__fixtures__/legacy-citation-rows.json` holds, per jurisdiction, the
 * builder's inputs (the extracted citations, the sections, the publisher's
 * procedural keys, the language and the compiled rules with fixed ids) and the
 * rows it returned for them. The outputs are frozen: each vector is planned
 * again through `planDecisionCitations` and projected through
 * `citationRowsOf`, and the result must equal the recorded rows field for
 * field. The census below keeps the vectors covering what the projection
 * decides: both kinds, a mixed, a null and a rule-given polarity, every typed
 * identity the extractor produces, and every hint.
 */

import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import * as v from "valibot";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { ScopedDb } from "@/api/db/safe-db";
import { CITATION_DECISION_TYPE_HINTS } from "@/api/handlers/case-law/citation-decision-type-hint";
import { CITATION_KINDS } from "@/api/handlers/case-law/citation-kind";
import {
  citationRowsOf,
  planDecisionCitations,
} from "@/api/handlers/case-law/ingestion/pipeline/citations";
import { POLARITIES, POLARITY } from "@/api/handlers/case-law/polarity/consts";
import { compileRules } from "@/api/handlers/case-law/polarity/rule-engine";
import { toSafeId } from "@/api/lib/branded-types";

const nullableString = v.nullable(v.string());

const VectorFile = v.object({
  description: v.string(),
  vectors: v.array(
    v.object({
      name: v.string(),
      citingDecisionId: v.string(),
      language: v.string(),
      proceduralKeys: v.array(v.string()),
      rules: v.array(
        v.object({
          id: v.string(),
          pattern: v.string(),
          polarity: v.picklist(POLARITIES),
          confidence: v.number(),
        }),
      ),
      sections: v.array(v.object({ index: v.number(), text: v.string() })),
      citations: v.array(
        v.object({
          citationText: v.string(),
          sectionIndex: v.nullable(v.number()),
          citedDecisionTypeHint: v.nullable(
            v.picklist(CITATION_DECISION_TYPE_HINTS),
          ),
          identifierType: v.picklist(Object.values(DECISION_IDENTIFIER_TYPES)),
          identifierValue: v.string(),
          citedCourtHint: nullableString,
          citedSheetNumber: nullableString,
          citedDecisionDate: nullableString,
        }),
      ),
      rows: v.array(
        v.object({
          citingDecisionId: v.string(),
          citationText: v.string(),
          citationKey: nullableString,
          identifierType: nullableString,
          normalizedIdentifierValue: nullableString,
          citedDecisionTypeHint: nullableString,
          citedCourtHint: nullableString,
          citedSheetNumber: nullableString,
          citedDecisionDate: nullableString,
          kind: v.string(),
          sectionIndex: v.nullable(v.number()),
          polarity: nullableString,
          polarityRuleId: nullableString,
        }),
      ),
    }),
  ),
});

const { vectors } = v.parse(
  VectorFile,
  JSON.parse(
    readFileSync(
      nodePath.join(import.meta.dir, "__fixtures__/legacy-citation-rows.json"),
      "utf-8",
    ),
  ),
);

/** The rules come from each vector; nothing may reach for a database. */
const noDatabase: ScopedDb = () =>
  panic("a vector's rules are passed in, never loaded");

test.each(vectors.map((vector) => [vector.name, vector] as const))(
  "%s: the references project to the recorded rows",
  async (_name, vector) => {
    const plan = await planDecisionCitations({
      citations: vector.citations,
      citingDecisionId: toSafeId<"caseLawDecision">(vector.citingDecisionId),
      language: vector.language,
      polarityRules: new Map([
        [
          vector.language,
          compileRules(
            vector.rules.map((rule) => ({
              ...rule,
              id: toSafeId<"caseLawPolarityRule">(rule.id),
            })),
          ),
        ],
      ]),
      proceduralKeys: new Set(vector.proceduralKeys),
      scopedDb: noDatabase,
      sections: vector.sections,
    });
    const rows: unknown = citationRowsOf(plan);
    expect(rows).toEqual(vector.rows);
  },
);

test("the vectors cover what the projection decides", () => {
  const rows = vectors.flatMap((vector) => vector.rows);
  expect(vectors.map(({ name }) => name).toSorted()).toEqual(
    ["AUT", "CZE", "EU", "HUN", "POL", "SVK"].toSorted(),
  );
  expect(new Set(rows.map(({ kind }) => kind))).toEqual(
    new Set(CITATION_KINDS),
  );
  const polarities = new Set(rows.map(({ polarity }) => polarity));
  expect(polarities.has(POLARITY.MIXED)).toBe(true);
  expect(polarities.has(null)).toBe(true);
  expect(
    rows.some(
      ({ polarity, polarityRuleId }) =>
        polarity !== POLARITY.MIXED && polarityRuleId !== null,
    ),
  ).toBe(true);
  expect(new Set(rows.map(({ identifierType }) => identifierType))).toEqual(
    new Set([
      DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      DECISION_IDENTIFIER_TYPES.ECLI,
      DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    ]),
  );
  // A typed identity read from a spelling other than the printed one.
  expect(
    rows.some(
      ({ citationKey, normalizedIdentifierValue }) =>
        normalizedIdentifierValue !== citationKey,
    ),
  ).toBe(true);
  for (const hint of [
    "citedDecisionTypeHint",
    "citedCourtHint",
    "citedSheetNumber",
    "citedDecisionDate",
  ] as const) {
    expect(rows.some((row) => row[hint] !== null)).toBe(true);
  }
});
