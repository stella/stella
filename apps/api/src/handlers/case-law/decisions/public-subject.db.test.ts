import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import Elysia, { t } from "elysia";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import {
  createSafePublicSubjectHandler,
  withRedistributableSubject,
} from "@/api/handlers/case-law/decisions/public-subject";
import type { RedistributableDecisionSubject } from "@/api/handlers/case-law/decisions/public-subject";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { tSafeId } from "@/api/lib/custom-schema";
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
});

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
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
      query: t.Object({ language: t.Optional(t.String()) }),
    } satisfies PublicHandlerConfig,
    caseLawDb,
    locate: ({ params: { slug }, query: { language } }) => ({
      kind: "slug",
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
      "/s/closed-case",
      "/s/no-such-slug",
      "/s/open-case?language=xx_notalanguage!",
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
      "/s/open-case",
      "/s/open-case?language=CS",
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
      "/s/variant-case?language=pt-br",
      "/s/variant-case?language=PT_BR",
      "/s/variant-case?language=pt_br",
    ]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ reached: variantId });
    }
    // A different tag must still miss, so the normalisation is not a wildcard.
    expect((await get("/s/variant-case?language=pt")).status).toBe(404);
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
