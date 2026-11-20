import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { directoryCourtIdentities } from "@stll/api-contract/court-identity";
import { docketFamilyKeyOf } from "@stll/api-contract/decision-docket-reference";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { propertyTestTimeout } from "@stll/property-testing";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { observeDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision-identity";
import { matchHostDecisionsTx } from "@/api/handlers/case-law/ingestion/pipeline/held-decision-attachment";
import { createSafeId } from "@/api/lib/branded-types";
import { legacyTrustedUsaCourts } from "@/api/lib/case-law/decision-court-identity";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { heldDecisionEcliIdentity } from "@/api/lib/case-law/held-decision-candidate-query";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import type { HeldDecisionAttachment } from "@/api/lib/legal-search/held-decision-attachment";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  createIngestionRoleScopedDb,
  createTestPglite,
} from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
}, propertyTestTimeout(120_000));
afterAll(async () => await client.close());
const usaCourt =
  legacyTrustedUsaCourts().at(0) ?? panic("USA fixture court is absent");
const czechCourt =
  directoryCourtIdentities("CZE").find(
    ({ name }) => name === "Nejvyšší soud",
  ) ?? panic("Czech fixture court is absent");

const source = async () => {
  const id = createSafeId<"caseLawSource">();
  const adapterKey = `candidate-${id}`;
  await db
    .insert(caseLawSources)
    .values({ id, adapterKey, name: "Collection identity fixture" });
  return { id, adapterKey };
};
const fixture = async (index: number) => {
  const publisher = await source();
  const collection = await source();
  const declaration = {
    hostAdapterKeys: [publisher.adapterKey],
    metadataKey: "collectionEntry",
    metadataSchema: v.object({}),
    declaredIdentifierTypes: [DECISION_IDENTIFIER_TYPES.REPORTER_CITATION],
    docketHeldUnderOtherDate: "park-for-review",
  } as const satisfies HeldDecisionAttachment<string>;
  const input = plainTextIngestionResult({
    country: "USA",
    language: "en",
    court: usaCourt.name,
    courtId: usaCourt.courtId,
    caseNumber: `24-${index}`,
    decisionDate: "2024-01-01",
    sourceDocumentId: "incoming-post",
    rawHash: "fixture",
    fulltext: "Fixture report body.",
    documentAst: EMPTY_AST,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    metadata: { collectionEntry: {} },
  });
  const host = async (
    fields: Partial<typeof caseLawDecisions.$inferInsert> = {},
  ) => {
    const id = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values({
      id,
      sourceId: publisher.id,
      sourceDocumentId: id,
      country: input.country,
      language: input.language,
      court: input.court,
      courtId: input.courtId,
      caseNumber: input.caseNumber,
      decisionDate: input.decisionDate,
      docketFamilyKey: docketFamilyKeyOf(input.caseNumber, input.country),
      ...fields,
    });
    return id;
  };
  const match = async (
    observedInput = input,
    policy: HeldDecisionAttachment<string> = declaration,
  ) => {
    const observation = observeDecision({
      sourceId: collection.id,
      input: observedInput,
      heldDecisionAttachment: policy,
    }).unwrap();
    return await createIngestionRoleScopedDb(db)(
      async (tx) =>
        await matchHostDecisionsTx(tx, {
          sourceId: collection.id,
          declaration: policy,
          observation,
        }),
    );
  };
  return {
    publisher,
    collection,
    declaration,
    input,
    host,
    match,
    ecli: `ECLI:US:SCOTUS:2024:${index}`,
  };
};

test("an independently registered non-Czech publisher outside attachment policy prevents own creation", async () => {
  const f = await fixture(1);
  const hostId = await f.host();
  const result = await f.match(f.input, {
    ...f.declaration,
    hostAdapterKeys: ["another-publisher"],
  });
  expect(result).toMatchObject({
    type: "review",
    basis: "source-policy",
    candidateDecisionIds: [hostId],
    evidence: { status: "outside-policy", adapterKey: f.publisher.adapterKey },
  });
});

test("a historical primary ECLI still matches when its identifier projection is absent", async () => {
  const f = await fixture(2);
  const ecli = f.ecli;
  const hostId = await f.host({
    caseNumber: "24-99",
    docketFamilyKey: "24-99",
    ecli,
  });
  expect(await f.match({ ...f.input, ecli })).toMatchObject({
    type: "one",
    basis: "ecli",
    host: { id: hostId },
  });
  expect(
    await f.match(
      { ...f.input, ecli },
      { ...f.declaration, hostAdapterKeys: ["another-publisher"] },
    ),
  ).toMatchObject({
    type: "review",
    basis: "source-policy",
    candidateDecisionIds: [hostId],
  });
});

test("same-source posts find an existing sibling", async () => {
  const f = await fixture(3);
  const hostId = await f.host({ sourceId: f.collection.id });
  expect(await f.match()).toMatchObject({
    type: "one",
    basis: "court-docket-date",
    host: { id: hostId },
  });
});

test("approved retired aliases collapse before the bounded candidate cap", async () => {
  const f = await fixture(4);
  const hostId = await f.host();
  for (let n = 0; n < 12; n += 1) {
    const retiredId = await f.host();
    await db
      .insert(caseLawDecisionAliases)
      .values({ retiredDecisionId: retiredId, canonicalDecisionId: hostId });
  }
  expect(await f.match()).toMatchObject({ type: "one", host: { id: hostId } });
});

test("primary ECLI and canonical tuple disagreement parks instead of selecting either host", async () => {
  const f = await fixture(5);
  const ecli = f.ecli;
  const ecliId = await f.host({
    caseNumber: "24-99",
    docketFamilyKey: "24-99",
    ecli,
  });
  const tupleId = await f.host();
  expect(await f.match({ ...f.input, ecli })).toMatchObject({
    type: "review",
    evidence: {
      status: "conflict",
      ecliCandidateIds: [ecliId],
      courtDocketDateCandidateIds: [tupleId],
    },
  });
});

test("Czech absent and explicit zero senate share a stored legacy tuple without rewriting ECLI", async () => {
  const f = await fixture(6);
  const hostEcli = "ECLI:CZ:NS:2003:0.TS.42.2017.1";
  const hostId = await f.host({
    country: "CZE",
    language: "cs",
    court: czechCourt.name,
    courtId: czechCourt.id,
    caseNumber: "0 Ts 42/2003",
    docketFamilyKey: "0ts42/2003",
    ecli: hostEcli,
  });
  const input = {
    ...f.input,
    country: "CZE",
    language: "cs",
    court: czechCourt.name,
    courtId: undefined,
    caseNumber: "Ts 42/2003",
    ecli: "ECLI:CZ:NS:2003:0.TS.42.2003.1",
  };
  expect(await f.match(input)).toMatchObject({
    type: "one",
    basis: "court-docket-date",
    host: { id: hostId, ecli: hostEcli },
  });
});

test("placeholder and prose ECLIs cannot bypass missing ruling identity", () => {
  expect(heldDecisionEcliIdentity("CZE", "N/A")).toBeNull();
  expect(
    heldDecisionEcliIdentity("CZE", "See ECLI:CZ:NS:2024:1 for context"),
  ).toBeNull();
});
