import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import Elysia, { t } from "elysia";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { projectionDigest } from "@stll/legal-ast/projection-digest";
import { rejectionOf } from "@stll/property-testing/rejection";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/get";
import { createSafePublicSubjectHandler } from "@/api/handlers/case-law/decisions/public-subject";
import { ACCOUNT_ACCESS } from "@/api/lib/api-handlers";
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
      cache: { kind: "none" },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      params: t.Object({ decisionId: tSafeId("caseLawDecision") }),
    } satisfies PublicHandlerConfig,
    caseLawDb,
    locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
    read: async (subject) => await echoSubject(subject),
  });
  const bySlug = createSafePublicSubjectHandler({
    config: {
      cache: { kind: "none" },
      accountAccess: ACCOUNT_ACCESS.sandbox,
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
  "decision reads describe the AST actually served and null missing or redacted bodies",
  async () => {
    const storedAst = {
      version: 1,
      source: {
        system: "test",
        documentId: "served-ast",
        webUrl: "https://example.test/decision",
        printUrl: "",
      },
      metadata: {
        caseNumber: null,
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: [
        {
          id: "paragraph-1",
          anchorId: "p-1",
          type: "paragraph",
          inlines: [{ type: "text", text: "Served text" }],
          plainText: "Served text",
        },
      ],
    } satisfies DocumentAst;
    const astId = createSafeId<"caseLawDecision">();
    const bodylessId = createSafeId<"caseLawDecision">();
    const redactedId = createSafeId<"caseLawDecision">();
    const db = drizzle({ client });
    await db.insert(caseLawDecisions).values([
      {
        caseNumber: "served-ast",
        country: "CZE",
        court: "Court",
        documentAst: storedAst,
        id: astId,
        language: "cs",
        sourceUrl: "https://example.test/served-ast",
        sourceId: openSourceId,
      },
      {
        caseNumber: "bodyless-ast",
        country: "CZE",
        court: "Court",
        id: bodylessId,
        language: "cs",
        sourceUrl: "https://example.test/bodyless-ast",
        sourceId: openSourceId,
      },
      {
        caseNumber: "redacted-ast",
        country: "CZE",
        court: "Court",
        id: redactedId,
        language: "cs",
        redactedAt: new Date("2026-01-01T00:00:00Z"),
        sourceUrl: "https://example.test/redacted-ast",
        sourceId: openSourceId,
      },
    ]);
    const read = async (id: SafeId<"caseLawDecision">) => {
      const result = await withRedistributableSubject(
        caseLawDb,
        { kind: "id", id },
        async (subject) =>
          await readDecisionHandler({
            subject,
            readCourtWeights: async () => await Promise.resolve(new Map()),
          }),
      );
      if (result === null || !("documentPending" in result)) {
        throw new Error("Expected a public decision read");
      }
      return result;
    };

    const served = await read(astId);
    expect(served.documentAstSource).toBe("row");
    expect(served.projectionDigest).toBe(await projectionDigest(storedAst));
    expect(served.documentAst).not.toEqual(storedAst);

    for (const id of [bodylessId, redactedId]) {
      const withoutAst = await read(id);
      expect(withoutAst.documentAstSource).toBeNull();
      expect(withoutAst.projectionDigest).toBeNull();
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

test(
  "alias writes flatten chains, preserve retries, and refuse cycles, conflicts and stale targets",
  async () => {
    const db = drizzle({ client });
    const first = createSafeId<"caseLawDecision">();
    const later = createSafeId<"caseLawDecision">();
    const middle = createSafeId<"caseLawDecision">();
    const final = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values(
      [first, later, middle, final].map((id) => ({
        id,
        sourceId: openSourceId,
        country: "CZE",
        court: "Nejvyšší soud",
        language: "cs",
        caseNumber: id,
      })),
    );
    const alias = { retiredDecisionId: first, canonicalDecisionId: middle };
    await db.insert(caseLawDecisionAliases).values(alias);
    const initial = await db
      .select()
      .from(caseLawDecisionAliases)
      .where(eq(caseLawDecisionAliases.retiredDecisionId, first));
    expect(initial).toMatchObject([alias]);
    await db
      .insert(caseLawDecisionAliases)
      .values(alias)
      .onConflictDoUpdate({
        target: caseLawDecisionAliases.retiredDecisionId,
        set: { canonicalDecisionId: middle },
      });
    expect(
      await db
        .select()
        .from(caseLawDecisionAliases)
        .where(eq(caseLawDecisionAliases.retiredDecisionId, first)),
    ).toEqual(initial);
    for (const patch of [
      { retiredDecisionId: later },
      { createdAt: new Date("2000-01-01T00:00:00Z") },
    ]) {
      expect(
        await rejectionOf(
          db
            .update(caseLawDecisionAliases)
            .set(patch)
            .where(eq(caseLawDecisionAliases.retiredDecisionId, first))
            .execute(),
        ),
      ).toMatchObject({
        cause: {
          message: expect.stringContaining(
            "Decision alias identity is immutable",
          ),
        },
      });
    }
    expect(
      await rejectionOf(
        db
          .update(caseLawDecisionAliases)
          .set({ canonicalDecisionId: final })
          .where(eq(caseLawDecisionAliases.retiredDecisionId, first))
          .execute(),
      ),
    ).toMatchObject({
      cause: {
        message: expect.stringContaining("Conflicting decision alias target"),
      },
    });
    expect(
      await rejectionOf(
        db
          .insert(caseLawDecisionAliases)
          .values({ retiredDecisionId: middle, canonicalDecisionId: first })
          .execute(),
      ),
    ).toMatchObject({
      cause: { message: expect.stringContaining("Decision alias cycle") },
    });
    expect(
      await rejectionOf(
        db
          .insert(caseLawDecisionAliases)
          .values({ retiredDecisionId: middle, canonicalDecisionId: missingId })
          .execute(),
      ),
    ).toMatchObject({
      cause: {
        message: expect.stringContaining("Decision alias target is not live"),
      },
    });
    expect(
      await rejectionOf(
        db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.id, middle))
          .execute(),
      ),
    ).toMatchObject({
      cause: {
        code: "23001",
        message: expect.stringContaining(
          "case_law_decision_aliases_canonical_fk",
        ),
      },
    });
    await db
      .insert(caseLawDecisionAliases)
      .values({ retiredDecisionId: middle, canonicalDecisionId: final });
    await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, middle));
    await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, first));
    // A retry still naming the former survivor resolves to the same terminal target.
    await db
      .insert(caseLawDecisionAliases)
      .values(alias)
      .onConflictDoUpdate({
        target: caseLawDecisionAliases.retiredDecisionId,
        set: { canonicalDecisionId: middle },
      });
    // A new alias naming a retired target also stores the terminal UUID.
    await db.insert(caseLawDecisionAliases).values({
      retiredDecisionId: later,
      canonicalDecisionId: first,
    });
    await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, later));
    expect(
      await db
        .select({ target: caseLawDecisionAliases.canonicalDecisionId })
        .from(caseLawDecisionAliases)
        .where(eq(caseLawDecisionAliases.retiredDecisionId, later)),
    ).toEqual([{ target: final }]);
    expect(
      await rejectionOf(
        db
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.id, final))
          .execute(),
      ),
    ).toMatchObject({
      cause: {
        code: "23001",
        message: expect.stringContaining(
          "case_law_decision_aliases_canonical_fk",
        ),
      },
    });
    const rows = await db
      .select({ target: caseLawDecisionAliases.canonicalDecisionId })
      .from(caseLawDecisionAliases)
      .where(eq(caseLawDecisionAliases.retiredDecisionId, first));
    expect(rows).toEqual([{ target: final }]);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "only ingestion can register aliases; request and public-reader roles cannot access them",
  async () => {
    const db = drizzle({ client });
    const retiredId = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values({
      id: retiredId,
      sourceId: openSourceId,
      country: "CZE",
      court: "Court",
      language: "cs",
      caseNumber: retiredId,
    });
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      await tx
        .insert(caseLawDecisionAliases)
        .values({ retiredDecisionId: retiredId, canonicalDecisionId: openId });
    });
    for (const role of ["stella", "stella_public_law_reader"]) {
      expect(
        await rejectionOf(
          db.transaction(async (tx) => {
            await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
            await tx
              .select({ id: caseLawDecisionAliases.retiredDecisionId })
              .from(caseLawDecisionAliases);
          }),
        ),
      ).toMatchObject({
        cause: { message: expect.stringContaining("permission denied") },
      });
    }
    expect(
      await rejectionOf(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella_public_law_reader`);
          await tx
            .update(caseLawDecisionAliases)
            .set({ canonicalDecisionId: variantId })
            .where(eq(caseLawDecisionAliases.retiredDecisionId, retiredId));
        }),
      ),
    ).toMatchObject({
      cause: { message: expect.stringContaining("permission denied") },
    });
    expect(
      await rejectionOf(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
          await tx
            .delete(caseLawDecisionAliases)
            .where(eq(caseLawDecisionAliases.retiredDecisionId, retiredId));
        }),
      ),
    ).toMatchObject({
      cause: { message: expect.stringContaining("permission denied") },
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "alias registration requires a live retired row from the survivor's publisher",
  async () => {
    const db = drizzle({ client });
    for (const { retiredDecisionId, message } of [
      {
        retiredDecisionId: createSafeId<"caseLawDecision">(),
        message: "Register decision alias before retirement",
      },
      {
        retiredDecisionId: closedId,
        message: "Decision alias crosses publisher sources",
      },
    ]) {
      expect(
        await rejectionOf(
          db
            .insert(caseLawDecisionAliases)
            .values({
              retiredDecisionId,
              canonicalDecisionId: openId,
            })
            .execute(),
        ),
      ).toMatchObject({
        cause: { message: expect.stringContaining(message) },
      });
      expect(
        await db
          .select()
          .from(caseLawDecisionAliases)
          .where(
            eq(caseLawDecisionAliases.retiredDecisionId, retiredDecisionId),
          ),
      ).toEqual([]);
    }
  },
  DB_TEST_TIMEOUT_MS,
);
