import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import type { ClauseBody } from "@/api/lib/clauses/types";

import type { ClauseSlot } from "./discover-clause-slots";
import { resolveClauseSlots } from "./resolve-clause-slots";

const templateId = toSafeId<"template">("tmpl_1");
const organizationId = toSafeId<"organization">("org_1");
const clauseId = toSafeId<"clause">("cls_1");
const versionId = toSafeId<"clauseVersion">("clsv_1");

const versionBody: ClauseBody = [{ text: "Pinned version text." }];

type FakeRow = Record<string, unknown>;

type FakeRows = {
  templateClauses?: FakeRow[] | undefined;
  clauses?: FakeRow[] | undefined;
  clauseVersions?: FakeRow[] | undefined;
  clauseVariants?: FakeRow[] | undefined;
};

type FakeDb = {
  scopedDb: ScopedDb;
  /** Statements the resolver issued, so a test can pin the batching. */
  readCount: () => number;
};

/** ScopedDb stub backed by fixed row sets per table. */
const makeScopedDb = (rows: FakeRows): FakeDb => {
  let reads = 0;
  const read = (table: FakeRow[] | undefined): FakeRow[] => {
    reads += 1;
    return table ?? [];
  };

  const fakeTx = {
    query: {
      templateClauses: { findMany: async () => read(rows.templateClauses) },
      clauses: { findMany: async () => read(rows.clauses) },
      clauseVariants: { findMany: async () => read(rows.clauseVariants) },
    },
    // Version bodies come from the core select builder (one `or(...)` over the
    // (clauseId, version) and pinned-id targets), not the relational API.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => read(rows.clauseVersions),
        }),
      }),
    }),
  };

  // SAFETY: test stub; resolveClauseSlots only touches the batched relational
  // findMany methods and the select chain modeled above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const scopedDb = (async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(fakeTx)) as unknown as ScopedDb;

  return { scopedDb, readCount: () => reads };
};

describe("resolveClauseSlots variant tombstones", () => {
  test("a deleted variant does not fall back to the clause head", async () => {
    const { scopedDb, readCount } = makeScopedDb({
      templateClauses: [
        {
          slotName: "NonCompete",
          clauseId,
          clauseVariantId: null,
          clauseVariantLabel: "Strict",
          clauseVersionId: versionId,
        },
      ],
      clauseVersions: [
        { id: versionId, clauseId, version: 1, body: versionBody },
      ],
      clauses: [{ id: clauseId, currentVersion: 1 }],
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
    // Nothing is targeted, so the link read is the only statement.
    expect(readCount()).toBe(1);
  });

  test("an intact variant link still resolves", async () => {
    const variantId = toSafeId<"clauseVariant">("var_1");
    const { scopedDb } = makeScopedDb({
      templateClauses: [
        {
          slotName: "NonCompete",
          clauseId,
          clauseVariantId: variantId,
          clauseVariantLabel: "Strict",
          clauseVersionId: versionId,
        },
      ],
      clauseVariants: [{ id: variantId, body: [{ text: "Variant text." }] }],
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
    const { scopedDb } = makeScopedDb({
      templateClauses: [
        {
          slotName: "NonCompete",
          clauseId,
          clauseVariantId: null,
          clauseVariantLabel: "Strict",
          clauseVersionId: versionId,
        },
      ],
      clauses: [{ id: clauseId, currentVersion: 2 }],
      clauseVersions: [
        { id: versionId, clauseId, version: 2, body: versionBody },
      ],
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

/** Every resolution branch, one slot each, so the read count covers them all. */
const buildFixture = (slotCount: number) => {
  const slots: ClauseSlot[] = [];
  const templateClauses: FakeRow[] = [];
  const clauses: FakeRow[] = [];
  const clauseVersions: FakeRow[] = [];
  const clauseVariants: FakeRow[] = [];
  const expectedTexts: Record<string, string> = {};

  for (let index = 0; index < slotCount; index += 1) {
    const name = `Clause${index}`;
    const clause = toSafeId<"clause">(`cls_${index}`);
    const version = toSafeId<"clauseVersion">(`clsv_${index}`);
    const variant = toSafeId<"clauseVariant">(`var_${index}`);

    switch (index % 3) {
      case 0: {
        const patchKey = `@clause:${name}:latest`;
        slots.push({ name, versionModifier: "latest", patchKey });
        templateClauses.push({
          slotName: name,
          clauseId: clause,
          clauseVariantId: null,
          clauseVariantLabel: null,
          clauseVersionId: null,
        });
        clauses.push({ id: clause, currentVersion: 3 });
        clauseVersions.push({
          id: version,
          clauseId: clause,
          version: 3,
          body: [{ text: `${name} latest` }],
        });
        expectedTexts[patchKey] = `${name} latest`;
        break;
      }
      case 1: {
        const patchKey = `@clause:${name}`;
        slots.push({ name, patchKey });
        templateClauses.push({
          slotName: name,
          clauseId: clause,
          clauseVariantId: null,
          clauseVariantLabel: null,
          clauseVersionId: version,
        });
        clauseVersions.push({
          id: version,
          clauseId: clause,
          version: 1,
          body: [{ text: `${name} pinned` }],
        });
        expectedTexts[patchKey] = `${name} pinned`;
        break;
      }
      default: {
        const patchKey = `@clause:${name}`;
        slots.push({ name, patchKey });
        templateClauses.push({
          slotName: name,
          clauseId: clause,
          clauseVariantId: variant,
          clauseVariantLabel: "Strict",
          clauseVersionId: version,
        });
        clauseVariants.push({
          id: variant,
          body: [{ text: `${name} variant` }],
        });
        expectedTexts[patchKey] = `${name} variant`;
      }
    }
  }

  return {
    slots,
    expectedTexts,
    rows: { templateClauses, clauses, clauseVersions, clauseVariants },
  };
};

describe("resolveClauseSlots batching", () => {
  // One statement per table the slot set targets, never one per slot.
  const READS_PER_CALL = 4;

  test.each([6, 30])(
    "%i slots cost a fixed number of reads",
    async (slotCount) => {
      const { slots, expectedTexts, rows } = buildFixture(slotCount);
      const { scopedDb, readCount } = makeScopedDb(rows);

      const patches = await resolveClauseSlots(
        templateId,
        slots,
        scopedDb,
        organizationId,
      );

      expect(readCount()).toBe(READS_PER_CALL);
      // Resolution and marker order both survive the batching.
      expect(Object.keys(patches)).toEqual(slots.map((slot) => slot.patchKey));
      expect(patches).toEqual(
        Object.fromEntries(
          Object.entries(expectedTexts).map(([patchKey, text]) => [
            patchKey,
            { paragraphs: [{ runs: [{ text }] }] },
          ]),
        ),
      );
    },
  );

  test("markers sharing a slot name resolve per version modifier", async () => {
    const { scopedDb } = makeScopedDb({
      templateClauses: [
        {
          slotName: "NonCompete",
          clauseId,
          clauseVariantId: null,
          clauseVariantLabel: null,
          clauseVersionId: versionId,
        },
      ],
      clauses: [{ id: clauseId, currentVersion: 4 }],
      clauseVersions: [
        { id: versionId, clauseId, version: 1, body: [{ text: "Pinned." }] },
        {
          id: toSafeId<"clauseVersion">("clsv_4"),
          clauseId,
          version: 4,
          body: [{ text: "Latest." }],
        },
      ],
    });

    const patches = await resolveClauseSlots(
      templateId,
      [
        { name: "NonCompete", patchKey: "@clause:NonCompete" },
        {
          name: "NonCompete",
          versionModifier: "latest",
          patchKey: "@clause:NonCompete:latest",
        },
      ],
      scopedDb,
      organizationId,
    );

    expect(patches).toEqual({
      "@clause:NonCompete": { paragraphs: [{ runs: [{ text: "Pinned." }] }] },
      "@clause:NonCompete:latest": {
        paragraphs: [{ runs: [{ text: "Latest." }] }],
      },
    });
  });
});
