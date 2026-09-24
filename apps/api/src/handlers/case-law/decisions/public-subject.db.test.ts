import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import Elysia, { t } from "elysia";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";

import { authRelationsPart } from "@/api/db/auth-schema";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import { createSafePublicSubjectHandler } from "@/api/handlers/case-law/decisions/public-subject";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  metadataWithDecisionAbsorption,
  supplementAnchorPrefix,
} from "@/api/lib/case-law/decision-absorption";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { tSafeId } from "@/api/lib/custom-schema";
import { DECISION_SUPPLEMENT_KIND } from "@/api/lib/legal-search/decision-supplement-kind";
import { metadataMarkedListingOnly } from "@/api/lib/legal-search/partial-observation-sql";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const openSourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const openId = createSafeId<"caseLawDecision">();
const closedId = createSafeId<"caseLawDecision">();
const missingId = createSafeId<"caseLawDecision">();
const variantId = createSafeId<"caseLawDecision">();
const unavailableCountryId = createSafeId<"caseLawDecision">();

/** Same budget as the schema push below: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;
/** The isolation each transaction was opened with, in order, per request. */
let opened: (string | undefined)[] = [];
/** The handle handed out by each of those opens. */
let handles: CaseLawPublicReadTransaction[] = [];

/**
 * What a gated read may answer with: its own subject, and proof of which
 * transaction its rows came from.
 */
const echoSubject = async (subject: RedistributableDecisionSubject) => ({
  reached: subject.id,
  readOnHandle: handles.indexOf(subject.tx),
  resolution: subject.resolution,
});

beforeAll(
  async () => {
    client = await createTestPglite();
    // Relations for the decision read's relational query.
    const db = drizzle({
      client,
      relations: { ...relations, ...authRelationsPart },
    });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
      options?: { isolation?: string },
    ) => {
      opened.push(options?.isolation);
      return await withPublicLawReaderRole(db, async (roleTx) => {
        // A fresh delegating handle per open, so a read that reached for its
        // own transaction is visible as a different object, not just a count.
        // SAFETY: a delegating view of the role transaction; the reads only
        // use its select surface.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = Object.create(roleTx) as CaseLawPublicReadTransaction;
        handles.push(tx);
        return await fn(tx);
      });
    };
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db.insert(caseLawSources).values([
      caseLawSourceRow({ adapterKey: "open", id: openSourceId, name: "open" }),
      caseLawSourceRow({
        adapterKey: "closed",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: null,
          license: "restricted",
        },
        id: closedSourceId,
        name: "closed",
      }),
    ]);
    await db.insert(caseLawDecisions).values([
      {
        caseNumber: "open",
        country: "CZE",
        court: "Court",
        id: openId,
        language: "cs",
        slug: "open-case",
        sourceId: openSourceId,
      },
      {
        caseNumber: "closed",
        country: "CZE",
        court: "Court",
        id: closedId,
        language: "cs",
        slug: "closed-case",
        sourceId: closedSourceId,
      },
      // Stored with the separator and case a publisher happened to use; the
      // lookup normalises both sides before comparing.
      {
        caseNumber: "variant",
        country: "CZE",
        court: "Court",
        id: variantId,
        language: "pt_BR",
        slug: "variant-case",
        sourceId: openSourceId,
      },
      {
        caseNumber: "unavailable-country",
        country: "XAA",
        court: "Court",
        id: unavailableCountryId,
        language: "xx",
        slug: "unavailable-country-case",
        sourceId: openSourceId,
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

/** A throwaway route per locator kind; the handler echoes the subject it got. */
const app = () => {
  const byId = createSafePublicSubjectHandler({
    config: {
      mcp: { type: "internal", reason: "public_indexing" },
      params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
    } satisfies PublicHandlerConfig,
    caseLawDb,
    locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
    read: async (subject) => await echoSubject(subject),
  });
  const bySlug = createSafePublicSubjectHandler({
    config: {
      mcp: { type: "internal", reason: "public_indexing" },
      params: t.Object({ slug: t.String() }),
      query: t.Object({
        country: t.String(),
        language: t.Optional(t.String()),
      }),
    } satisfies PublicHandlerConfig,
    caseLawDb,
    locate: ({ params: { slug }, query: { country, language } }) => ({
      kind: "slug",
      country,
      slug,
      language,
    }),
    read: async (subject) => await echoSubject(subject),
  });
  return new Elysia()
    .get("/d/:decisionId", byId.handler, { params: byId.config.params })
    .get("/s/:slug", bySlug.handler, {
      params: bySlug.config.params,
      query: bySlug.config.query,
    });
};

const get = async (path: string) => {
  opened = [];
  handles = [];
  return await app().handle(new Request(`http://localhost${path}`));
};

test(
  "a restricted or missing subject is not found, by id and by slug",
  async () => {
    for (const path of [
      `/d/${closedId}`,
      `/d/${missingId}`,
      `/d/${unavailableCountryId}`,
      "/s/closed-case?country=CZE",
      "/s/no-such-slug?country=CZE",
      "/s/unavailable-country-case?country=CZE",
      "/s/open-case?country=XAA",
      "/s/open-case?country=CZE&language=xx_notalanguage!",
      "/s/open-case?country=POL",
    ]) {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ message: "Decision not found" });
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a redistributable subject reaches the handler as the gated subject",
  async () => {
    for (const path of [
      `/d/${openId}`,
      "/s/open-case?country=CZE",
      "/s/open-case?country=cze&language=CS",
    ]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ reached: openId });
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "slug language matching normalises separator and case on both sides",
  async () => {
    for (const path of [
      "/s/variant-case?country=CZE&language=pt-br",
      "/s/variant-case?country=CZE&language=PT_BR",
      "/s/variant-case?country=CZE&language=pt_br",
    ]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ reached: variantId });
    }
    // A different tag must still miss, so the normalisation is not a wildcard.
    expect((await get("/s/variant-case?country=CZE&language=pt")).status).toBe(
      404,
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the resolver answers the same way outside a route",
  async () => {
    expect(
      await withRedistributableSubject(
        caseLawDb,
        { kind: "id", id: closedId },
        async (subject) => subject.id,
      ),
    ).toBeNull();
    expect(
      await withRedistributableSubject(
        caseLawDb,
        { kind: "id", id: openId },
        async (subject) => subject.id,
      ),
    ).toBe(openId);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the gate and the read share one repeatable-read transaction",
  async () => {
    // The window this closes: gate in one transaction, read in another, and
    // a source turned restricted in between still answers with content under
    // a brand that says "gated". One transaction leaves no in-between, and
    // repeatable read makes every statement under it see the state the gate
    // judged.
    const response = await get(`/d/${openId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reached: openId,
      // The first (and only) transaction of the request: the read's rows
      // come from the one that approved the subject.
      readOnHandle: 0,
      resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
    });
    expect(opened).toEqual(["repeatable-read"]);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "revoking a source stops the endpoint answering for its decisions",
  async () => {
    const db = drizzle({ client });
    const revoked = createSafeId<"caseLawSource">();
    const decision = createSafeId<"caseLawDecision">();
    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        adapterKey: "revoked",
        id: revoked,
        name: "revoked",
      }),
    ]);
    await db.insert(caseLawDecisions).values([
      {
        caseNumber: "revoked",
        country: "CZE",
        court: "Court",
        id: decision,
        language: "cs",
        slug: "revoked-case",
        sourceId: revoked,
      },
    ]);
    expect((await get(`/d/${decision}`)).status).toBe(200);

    await db
      .update(caseLawSources)
      .set({
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: null,
          license: "restricted",
        },
      })
      .where(eq(caseLawSources.id, revoked));

    // The gate reads the policy on every request, so the next one is closed.
    const after = await get(`/d/${decision}`);
    expect(after.status).toBe(404);
    expect(await after.json()).toEqual({ message: "Decision not found" });
  },
  DB_TEST_TIMEOUT_MS,
);

type AbsorbedRowOptions = {
  slug: string;
  sourceDocumentId: string;
  judgmentId: SafeId<"caseLawDecision">;
};

/**
 * A supplement row absorbed into `judgmentId`, marked through the writers
 * the absorption itself uses.
 */
const insertAbsorbedRow = async ({
  slug,
  sourceDocumentId,
  judgmentId,
}: AbsorbedRowOptions): Promise<SafeId<"caseLawDecision">> => {
  const db = drizzle({ client });
  const id = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    caseNumber: "absorbed",
    country: "CZE",
    court: "Court",
    id,
    language: "cs",
    slug,
    sourceDocumentId,
    sourceId: openSourceId,
  });
  await db
    .update(caseLawDecisions)
    .set({
      metadata: metadataWithDecisionAbsorption(
        metadataMarkedListingOnly(caseLawDecisions.metadata),
        {
          decisionId: judgmentId,
          kind: DECISION_SUPPLEMENT_KIND.REASONS,
          sourceDocumentId,
        },
      ),
    })
    .where(eq(caseLawDecisions.id, id));
  return id;
};

test(
  "an absorbed supplement's id and slug reach the judgment it went into",
  async () => {
    const absorbedId = await insertAbsorbedRow({
      slug: "absorbed-reasons",
      sourceDocumentId: "syn-reasons-1",
      judgmentId: openId,
    });
    const resolution = {
      type: DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT,
      absorbedDecisionId: absorbedId,
      anchorPrefix: supplementAnchorPrefix({
        kind: DECISION_SUPPLEMENT_KIND.REASONS,
        sourceDocumentId: "syn-reasons-1",
      }),
    };

    for (const path of [
      `/d/${absorbedId}`,
      "/s/absorbed-reasons?country=CZE",
    ]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        reached: openId,
        readOnHandle: 0,
        resolution,
      });
    }

    // The decision read answers with the judgment itself, and says why.
    const read = await withRedistributableSubject(
      caseLawDb,
      { kind: "id", id: absorbedId },
      async (subject) =>
        await readDecisionHandler({
          subject,
          readCourtWeights: async () => await Promise.resolve(new Map()),
        }),
    );
    expect(read).toMatchObject({ id: openId, caseNumber: "open", resolution });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "an absorbed supplement is not found unless its judgment passes the gate",
  async () => {
    const db = drizzle({ client });
    const unpublishedJudgment = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values({
      caseNumber: "unpublished",
      country: "CZE",
      court: "Court",
      id: unpublishedJudgment,
      language: "cs",
      sourceId: openSourceId,
    });
    await db
      .update(caseLawDecisions)
      .set({ metadata: metadataMarkedListingOnly(caseLawDecisions.metadata) })
      .where(eq(caseLawDecisions.id, unpublishedJudgment));

    for (const [index, judgmentId] of [
      closedId,
      missingId,
      unavailableCountryId,
      unpublishedJudgment,
    ].entries()) {
      const absorbedId = await insertAbsorbedRow({
        slug: `absorbed-into-hidden-${String(index)}`,
        sourceDocumentId: `syn-hidden-${String(index)}`,
        judgmentId,
      });
      for (const path of [
        `/d/${absorbedId}`,
        `/s/absorbed-into-hidden-${String(index)}?country=CZE`,
      ]) {
        const response = await get(path);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          message: "Decision not found",
        });
      }
    }
  },
  DB_TEST_TIMEOUT_MS,
);
