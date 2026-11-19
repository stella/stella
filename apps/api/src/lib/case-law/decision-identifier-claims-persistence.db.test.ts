import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { propertyTestTimeout } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawHeldDecisionAttachments,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import {
  type CitationGraphTransaction,
  runCitationGraphTransaction,
} from "@/api/handlers/case-law/citation-graph-transaction";
import { createSafeId } from "@/api/lib/branded-types";
import { legacyTrustedUsaCourts } from "@/api/lib/case-law/decision-court-identity";
import {
  declareDecisionIdentifiersTx,
  refreshHostDecisionIdentifiersTx,
  withdrawAttachmentIdentifiersTx,
} from "@/api/lib/case-law/decision-identifier-claims-persistence";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import {
  createIngestionRoleScopedDb,
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
}, propertyTestTimeout(120_000));
afterAll(async () => await client.close());

const identifier = {
  type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  value: "Fixture Reports 3",
  normalizedValue: "fixturereports3",
} as const;
const court =
  legacyTrustedUsaCourts().at(0) ?? panic("USA fixture court is absent");
const courtId = court.courtId;
const observedAt = new Date("2026-11-19T10:00:00Z");

const fixture = async () => {
  const sourceId = createSafeId<"caseLawSource">();
  const decisionId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `identifier-claims-${sourceId}`,
    name: "Identifier claims fixture",
  });
  await db.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId,
    sourceDocumentId: "decision",
    caseNumber: "Fixture 3/2024",
    court: court.name,
    courtId,
    country: "USA",
    language: "en",
    sourceHash: "fixture",
  });
  const write = async (
    run: (tx: CitationGraphTransaction<Transaction>) => Promise<void>,
  ) => await runCitationGraphTransaction(createIngestionRoleScopedDb(db), run);
  const attachment = async (
    post: string,
    identifiers: (typeof identifier)[],
  ) => {
    await db
      .insert(caseLawHeldDecisionAttachments)
      .values({
        sourceId,
        sourceDocumentId: post,
        hostDecisionId: decisionId,
        matchBasis: "ecli",
        declaredIdentifiers: identifiers,
        sourceHash: "fixture",
        observedAt,
        observationOrder: 1n,
      })
      .onConflictDoUpdate({
        target: [
          caseLawHeldDecisionAttachments.sourceId,
          caseLawHeldDecisionAttachments.sourceDocumentId,
        ],
        set: { declaredIdentifiers: identifiers },
      });
  };
  const rows = async () =>
    await db
      .select({
        claims: caseLawDecisionIdentifiers.independentClaims,
        version: sql<string>`xmin::text`,
      })
      .from(caseLawDecisionIdentifiers)
      .where(eq(caseLawDecisionIdentifiers.decisionId, decisionId));
  return { sourceId, decisionId, write, attachment, rows };
};

test("a host identifier survives attachment grant, refresh and withdrawal with replay no-ops", async () => {
  const f = await fixture();
  await f.write(
    async (tx) =>
      await refreshHostDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  await f.attachment("part", [identifier]);
  const grant = async () =>
    await f.write(
      async (tx) =>
        await declareDecisionIdentifiersTx(tx, {
          decisionId: f.decisionId,
          identifiers: [identifier],
          claim: { type: "attachment", observedAt },
        }),
    );
  await grant();
  const granted = await f.rows();
  await grant();
  expect(await f.rows()).toEqual(granted);
  await f.write(
    async (tx) =>
      await refreshHostDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  expect(await f.rows()).toEqual(granted);
  await f.attachment("part", []);
  await f.write(
    async (tx) =>
      await withdrawAttachmentIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  expect(await f.rows()).toEqual(granted);
});

test("the last attachment can withdraw an identifier the host has ceased to derive", async () => {
  const f = await fixture();
  await f.write(
    async (tx) =>
      await refreshHostDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  for (const post of ["one", "two"]) {
    await f.attachment(post, [identifier]);
  }
  await f.write(
    async (tx) =>
      await declareDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
        claim: { type: "attachment", observedAt },
      }),
  );
  await f.write(
    async (tx) =>
      await refreshHostDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [],
      }),
  );
  expect((await f.rows()).at(0)?.claims).toEqual([]);
  await f.attachment("one", []);
  await f.write(
    async (tx) =>
      await withdrawAttachmentIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  expect(await f.rows()).toHaveLength(1);
  await f.attachment("two", []);
  await f.write(
    async (tx) =>
      await withdrawAttachmentIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  expect(await f.rows()).toEqual([]);
});

test("retired alias and host claims remain independent of attachment withdrawal", async () => {
  const f = await fixture();
  await f.write(
    async (tx) =>
      await refreshHostDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  await f.write(
    async (tx) =>
      await declareDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
        claim: { type: "retired-alias", observedAt },
      }),
  );
  await f.attachment("part", [identifier]);
  await f.write(
    async (tx) =>
      await declareDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
        claim: { type: "attachment", observedAt },
      }),
  );
  expect((await f.rows()).at(0)?.claims).toEqual(["host", "retired-alias"]);
  await f.attachment("part", []);
  await f.write(
    async (tx) =>
      await withdrawAttachmentIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  await f.write(
    async (tx) =>
      await refreshHostDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [],
      }),
  );
  expect((await f.rows()).at(0)?.claims).toEqual(["retired-alias"]);
});

test("an unverified historical declaration is retained after refresh and withdrawal", async () => {
  const f = await fixture();
  await db.insert(caseLawDecisionIdentifiers).values({
    decisionId: f.decisionId,
    ...identifier,
    declaredAt: observedAt,
  });
  await f.attachment("part", [identifier]);
  await f.write(
    async (tx) =>
      await declareDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
        claim: { type: "attachment", observedAt },
      }),
  );
  await f.attachment("part", []);
  await f.write(
    async (tx) =>
      await withdrawAttachmentIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  await f.write(
    async (tx) =>
      await refreshHostDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [],
      }),
  );
  expect((await f.rows()).at(0)?.claims).toEqual(["unverified"]);
});

test("ownership claims remain private to ingestion while public identifiers are readable", async () => {
  const f = await fixture();
  await f.write(
    async (tx) =>
      await refreshHostDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  const denied = await rejectionOf(
    withPublicLawReaderRole(
      db,
      async (tx) =>
        await tx.execute(
          sql`SELECT independent_claims FROM case_law_decision_identifiers LIMIT 1`,
        ),
    ),
  );
  expect(getPgErrorCode(denied)).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
  const visible = await withPublicLawReaderRole(
    db,
    async (tx) =>
      await tx
        .select({
          type: caseLawDecisionIdentifiers.type,
          value: caseLawDecisionIdentifiers.value,
        })
        .from(caseLawDecisionIdentifiers)
        .where(eq(caseLawDecisionIdentifiers.decisionId, f.decisionId)),
  );
  expect(visible).toEqual([{ type: identifier.type, value: identifier.value }]);
});

test("a legacy undeclared host identifier acquires proved host support on grant", async () => {
  const f = await fixture();
  await db
    .insert(caseLawDecisionIdentifiers)
    .values({ decisionId: f.decisionId, ...identifier });
  await f.attachment("part", [identifier]);
  await f.write(
    async (tx) =>
      await declareDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
        claim: { type: "attachment", observedAt },
      }),
  );
  expect((await f.rows()).at(0)?.claims).toEqual(["host"]);
  await f.attachment("part", []);
  await f.write(
    async (tx) =>
      await withdrawAttachmentIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [identifier],
      }),
  );
  expect(await f.rows()).toHaveLength(1);
  await f.write(
    async (tx) =>
      await refreshHostDecisionIdentifiersTx(tx, {
        decisionId: f.decisionId,
        identifiers: [],
      }),
  );
  expect(await f.rows()).toEqual([]);
});
