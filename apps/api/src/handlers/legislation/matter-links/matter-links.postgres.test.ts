import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  legislationDocuments,
  legislationMatterLinks,
  legislationSources,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { linkProvisionsToMatter } from "@/api/handlers/legislation/matter-links/link-writes";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { resolveMatterLinkProvisions } from "@/api/lib/legal-search/legislation-matter-link-provisions";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
let db: TestDatabase;
let ids: TestIds;
const sourceId = createSafeId<"legislationSource">();
const czechVersion = createSafeId<"legislationDocument">();
const slovakVersion = createSafeId<"legislationDocument">();
const audit: AuditRecorder = async () => undefined;
const ast: DocumentAst = {
  version: 1,
  source: { system: "test", documentId: "", webUrl: "", printUrl: "" },
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
      id: "p1",
      type: "paragraph",
      anchorId: "par-1",
      inlines: [{ text: "Provision one", type: "text" }],
      plainText: "Provision one",
    },
  ],
};

describe.skipIf(!runPostgresTests)("legislation matter links", () => {
  beforeAll(async () => {
    db = await getTestDb();
    ids = createTestIds();
    await setupRlsTestData(db, ids);
    await db.insert(legislationSources).values({
      id: sourceId,
      adapterKey: `matter-links-${sourceId}`,
      name: "Matter links",
    });
    await db.insert(legislationDocuments).values([
      {
        id: czechVersion,
        sourceId,
        eli: "CZ/2012/89",
        title: "Czech Civil Code",
        country: "CZE",
        language: "cs",
        versionValidFrom: "2024-01-01",
        documentAst: ast,
      },
      {
        id: slovakVersion,
        sourceId,
        eli: "SK/1964/40",
        title: "Slovak Civil Code",
        country: "SVK",
        language: "sk",
        versionValidFrom: "2025-01-01",
        documentAst: ast,
      },
    ]);
  });
  afterAll(async () => {
    await releaseTestDb();
  });

  const item = (
    jurisdiction: "CZE" | "SVK",
  ): {
    statuteId: string;
    provisionId: string;
    version: string;
    jurisdiction: string;
  } =>
    jurisdiction === "CZE"
      ? {
          statuteId: "CZ/2012/89",
          provisionId: "par-1",
          version: "2024-01-01",
          jurisdiction,
        }
      : {
          statuteId: "SK/1964/40",
          provisionId: "par-1",
          version: "2025-01-01",
          jurisdiction,
        };

  const link = async (
    items: readonly ReturnType<typeof item>[],
    workspaceIds = [ids.wsA1],
  ) => {
    const provisions = await resolveMatterLinkProvisions({
      items,
      legislationDb: async (fn) => await fn(asTestRaw(db)),
    });
    return await createScopedDb(
      db,
      workspaceIds,
      ids.orgA,
      ids.userA1,
    )(
      async (tx) =>
        await linkProvisionsToMatter({
          tx: asTestRaw(tx),
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
          provisions,
          recordAuditEvent: audit,
        }),
    );
  };

  test("batch preserves a valid provision when another jurisdiction is rejected", async () => {
    await db
      .delete(legislationMatterLinks)
      .where(eq(legislationMatterLinks.workspaceId, ids.wsA1));
    const czech = item("CZE");
    const austrian = { ...czech, jurisdiction: "AUT" };
    const outcome = await link([czech, austrian]);

    expect(outcome.linked).toHaveLength(1);
    expect(outcome.linked.at(0)).toMatchObject({
      documentId: czechVersion,
      statuteId: czech.statuteId,
      provisionId: czech.provisionId,
      appliedVersion: czech.version,
      jurisdiction: czech.jurisdiction,
    });
    expect(outcome.existing).toEqual([]);
    expect(outcome.rejected).toEqual([
      { ...austrian, reason: "out_of_jurisdiction" },
    ]);
  });

  test("rejects ambiguous versions and sources that withhold redistribution", async () => {
    const request = item("CZE");
    const translatedId = createSafeId<"legislationDocument">();
    await db.insert(legislationDocuments).values({
      id: translatedId,
      sourceId,
      eli: request.statuteId,
      title: "Civil Code translation",
      country: request.jurisdiction,
      language: "en",
      versionValidFrom: request.version,
      documentAst: ast,
    });
    const ambiguous = await link([request]);
    expect(ambiguous.linked).toEqual([]);
    expect(ambiguous.existing).toEqual([]);
    expect(ambiguous.rejected).toEqual([
      { ...request, reason: "ambiguous_version" },
    ]);
    await db
      .delete(legislationDocuments)
      .where(eq(legislationDocuments.id, translatedId));
    await db
      .update(legislationSources)
      .set({
        descriptor: {
          license: "restricted",
          attribution: null,
          allowsRedistribution: false,
          allowsDerivedAi: false,
        },
      })
      .where(eq(legislationSources.id, sourceId));
    const withheld = await link([request]);
    expect(withheld.linked).toEqual([]);
    expect(withheld.existing).toEqual([]);
    expect(withheld.rejected).toEqual([{ ...request, reason: "not_found" }]);
    await db
      .update(legislationSources)
      .set({ descriptor: null })
      .where(eq(legislationSources.id, sourceId));
  });

  test("links the canonical anchor assigned to a repeated legacy anchor", async () => {
    await db
      .delete(legislationMatterLinks)
      .where(eq(legislationMatterLinks.workspaceId, ids.wsA1));
    await db
      .update(legislationDocuments)
      .set({
        documentAst: {
          ...ast,
          blocks: [
            ...ast.blocks,
            ...ast.blocks.map((block) => ({ ...block, id: "p2" })),
          ],
        },
      })
      .where(eq(legislationDocuments.id, czechVersion));
    const linked = await link([{ ...item("CZE"), provisionId: "par-1-2" }]);
    expect(linked.rejected).toEqual([]);
    expect(linked.linked).toHaveLength(1);
    expect(linked.linked.at(0)?.provisionId).toBe("par-1-2");
    await db
      .update(legislationDocuments)
      .set({ documentAst: ast })
      .where(eq(legislationDocuments.id, czechVersion));
  });

  test("create, retry, batch, list applied versions, delete, tenancy and refusals", async () => {
    await db
      .delete(legislationMatterLinks)
      .where(eq(legislationMatterLinks.workspaceId, ids.wsA1));
    const created = await link([item("CZE")]);
    expect(created.linked).toHaveLength(1);
    expect((await link([item("CZE")])).existing).toHaveLength(1);
    const batch = await link([item("CZE"), item("SVK")]);
    expect(batch.existing).toHaveLength(1);
    expect(batch.linked).toHaveLength(1);
    const rows = await db
      .select({
        version: legislationMatterLinks.appliedVersion,
        jurisdiction: legislationMatterLinks.jurisdiction,
      })
      .from(legislationMatterLinks)
      .where(eq(legislationMatterLinks.workspaceId, ids.wsA1));
    expect(
      rows.toSorted((a, b) => compareCodeUnit(a.jurisdiction, b.jurisdiction)),
    ).toEqual([
      { jurisdiction: "CZE", version: "2024-01-01" },
      { jurisdiction: "SVK", version: "2025-01-01" },
    ]);
    expect(
      (await link([{ ...item("CZE"), provisionId: "unknown" }])).rejected.at(0)
        ?.reason,
    ).toBe("not_found");
    expect(
      (await link([{ ...item("CZE"), jurisdiction: "AUT" }])).rejected.at(0)
        ?.reason,
    ).toBe("out_of_jurisdiction");
    expect(await rejectionOf(link([item("CZE")], [ids.wsB1]))).toHaveProperty(
      "message",
      expect.stringContaining("workspace"),
    );
    const deleted = await db
      .delete(legislationMatterLinks)
      .where(
        and(
          eq(legislationMatterLinks.workspaceId, ids.wsA1),
          eq(legislationMatterLinks.documentId, czechVersion),
        ),
      )
      .returning();
    expect(deleted).toHaveLength(1);
  });
});
