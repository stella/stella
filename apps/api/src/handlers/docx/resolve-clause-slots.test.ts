import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db";
import type { ClauseBody } from "@/api/handlers/clauses/types";
import { toSafeId } from "@/api/lib/branded-types";

import { resolveClauseSlots } from "./resolve-clause-slots";

const templateId = toSafeId<"template">("tmpl_1");
const organizationId = toSafeId<"organization">("org_1");
const clauseId = toSafeId<"clause">("cls_1");
const versionId = toSafeId<"clauseVersion">("clsv_1");

const versionBody: ClauseBody = [{ text: "Pinned version text." }];

type FakeRows = {
  templateClauses?: Record<string, unknown> | undefined;
  clauses?: Record<string, unknown> | undefined;
  clauseVersions?: Record<string, unknown> | undefined;
  clauseVariants?: Record<string, unknown> | undefined;
};

/** ScopedDb stub backed by fixed findFirst rows per table. */
const makeScopedDb = (rows: FakeRows): ScopedDb => {
  const fakeTx = {
    query: {
      templateClauses: { findFirst: async () => rows.templateClauses },
      clauses: { findFirst: async () => rows.clauses },
      clauseVersions: { findFirst: async () => rows.clauseVersions },
      clauseVariants: { findFirst: async () => rows.clauseVariants },
    },
  };
  // SAFETY: test stub; resolveClauseSlots only touches the relational
  // findFirst methods modeled above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(fakeTx)) as unknown as ScopedDb;
};

describe("resolveClauseSlots variant tombstones", () => {
  test("a deleted variant does not fall back to the clause head", async () => {
    const scopedDb = makeScopedDb({
      templateClauses: {
        clauseId,
        clauseVariantId: null,
        clauseVariantLabel: "Strict",
        clauseVersionId: versionId,
      },
      clauseVersions: { body: versionBody },
      clauses: { currentVersion: 1 },
    });

    const patches = await resolveClauseSlots(
      templateId,
      [{ name: "NonCompete", patchKey: "@clause:NonCompete" }],
      scopedDb,
      organizationId,
    );

    // The slot stays unfilled so the marker surfaces as an unmatched
    // placeholder (named after the slot) in fill diagnostics.
    expect(patches).toEqual({});
  });

  test("an intact variant link still resolves", async () => {
    const variantId = toSafeId<"clauseVariant">("var_1");
    const scopedDb = makeScopedDb({
      templateClauses: {
        clauseId,
        clauseVariantId: variantId,
        clauseVariantLabel: "Strict",
        clauseVersionId: versionId,
      },
      clauseVariants: { body: [{ text: "Variant text." }] },
    });

    const patches = await resolveClauseSlots(
      templateId,
      [{ name: "NonCompete", patchKey: "@clause:NonCompete" }],
      scopedDb,
      organizationId,
    );

    expect(patches["@clause:NonCompete"]).toEqual({
      paragraphs: [{ runs: [{ text: "Variant text." }] }],
    });
  });

  test("an explicit :latest modifier never used the variant and still fills", async () => {
    const scopedDb = makeScopedDb({
      templateClauses: {
        clauseId,
        clauseVariantId: null,
        clauseVariantLabel: "Strict",
        clauseVersionId: versionId,
      },
      clauses: { currentVersion: 2 },
      clauseVersions: { body: versionBody },
    });

    const patches = await resolveClauseSlots(
      templateId,
      [
        {
          name: "NonCompete",
          versionModifier: "latest",
          patchKey: "@clause:NonCompete:latest",
        },
      ],
      scopedDb,
      organizationId,
    );

    expect(patches["@clause:NonCompete:latest"]).toEqual({
      paragraphs: [{ runs: [{ text: "Pinned version text." }] }],
    });
  });
});
