import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  legislationDocuments,
  legislationMatterLinks,
  legislationSources,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import createLinks, {
  createLegislationMatterLinksBatchHandler,
} from "@/api/handlers/legislation/matter-links/batch/create";
import createLink, {
  createLegislationMatterLinkHandler,
} from "@/api/handlers/legislation/matter-links/create";
import deleteLink from "@/api/handlers/legislation/matter-links/delete";
import listLinks from "@/api/handlers/legislation/matter-links/list";
import { HttpStatusResponse } from "@/api/http/status";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

const TARGET_LINKS = 10;
const VERSION = "2025-01-01";
const STATUTE = "CZ/scaling/1";

export const seedLegislationMatterLinkScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`);
  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  const sourceId = createSafeId<"legislationSource">();
  const documentId = createSafeId<"legislationDocument">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Scaling firm",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Reviewer",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    userId,
    organizationId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(workspaces).values(
    [workspaceId, otherWorkspaceId].map((id) => ({
      id,
      organizationId,
      name: "Scaling matter",
      reference: id,
    })),
  );
  await db
    .insert(legislationSources)
    .values({ id: sourceId, adapterKey: sourceId, name: "Scaling statute" });
  const ast = {
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
    blocks: Array.from({ length: TARGET_LINKS + 3 }, (_, index) => ({
      id: `p${index}`,
      type: "paragraph",
      anchorId: `p${index}`,
      inlines: [{ text: "Provision", type: "text" }],
      plainText: "Provision",
    })),
  } satisfies DocumentAst;
  await db.insert(legislationDocuments).values({
    id: documentId,
    sourceId,
    eli: STATUTE,
    title: "Scaling statute",
    country: "CZE",
    language: "cs",
    versionValidFrom: VERSION,
    documentAst: ast,
  });
  const links = Array.from({ length: TARGET_LINKS }, (_, index) => ({
    id: createSafeId<"legislationMatterLink">(),
    workspaceId,
    documentId,
    statuteId: STATUTE,
    provisionId: `p${index}`,
    appliedVersion: VERSION,
    jurisdiction: "CZE",
    linkedBy: userId,
  }));
  await db.insert(legislationMatterLinks).values([
    ...links,
    ...Array.from({ length: size }, (_, index) => ({
      id: createSafeId<"legislationMatterLink">(),
      workspaceId: otherWorkspaceId,
      documentId,
      statuteId: STATUTE,
      provisionId: `other${index}`,
      appliedVersion: VERSION,
      jurisdiction: "CZE",
      linkedBy: userId,
    })),
  ]);
  const database = markRlsDatabase(db);
  return {
    db,
    workspaceId,
    userId,
    organizationId,
    linkId: links.at(0)?.id ?? panic("Scaling requires a linked provision"),
    legislationDb: async <T>(
      read: (tx: Pick<GatedTestDb, "select" | "execute">) => Promise<T>,
    ) => await read(db),
    context: {
      workspaceId,
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
      safeDb: createSafeDb(database, [workspaceId], organizationId, userId),
      scopedDb: createScopedDb(database, [workspaceId], organizationId, userId),
      audit: createAuditRecorder({
        organizationId,
        workspaceId,
        userId,
        request: new Request("https://example.test/matter-links"),
        server: null,
      }),
    },
    cleanup: async () => {
      await db
        .delete(workspaces)
        .where(eq(workspaces.organizationId, organizationId));
      await db
        .delete(legislationDocuments)
        .where(eq(legislationDocuments.id, documentId));
      await db
        .delete(legislationSources)
        .where(eq(legislationSources.id, sourceId));
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type Fixture = Awaited<ReturnType<typeof seedLegislationMatterLinkScaling>>;
const item = (provision: number) => ({
  statuteId: STATUTE,
  provisionId: `p${provision}`,
  version: VERSION,
  jurisdiction: "CZE",
});

export const legislationMatterLinkScalingScenarios = [
  {
    name: "legislation matter link list",
    definition: listLinks,
    expectedRows: TARGET_LINKS,
    measure: async (fixture: Fixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listLinks.handler(
          createTestHandlerContext<Parameters<typeof listLinks.handler>[0]>(
            fixture.context,
          ),
        );
        if (response instanceof HttpStatusResponse) {
          return panic("Scaling requires linked provisions");
        }
        if (response.links.length !== TARGET_LINKS) {
          return panic("Scaling must return only the current matter's links");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.links.length,
        };
      }),
  },
  {
    name: "legislation matter link create",
    definition: createLink,
    expectedRows: 1,
    measure: async (fixture: Fixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const handler = createLegislationMatterLinkHandler(
          fixture.legislationDb,
        );
        const response = await handler.handler(
          createTestHandlerContext<Parameters<typeof handler.handler>[0]>({
            ...fixture.context,
            body: item(TARGET_LINKS),
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.provisionId !== `p${TARGET_LINKS}`
        ) {
          return panic("Scaling requires a created provision link");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
  {
    name: "legislation matter link batch create",
    definition: createLinks,
    expectedRows: 2,
    measure: async (fixture: Fixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const handler = createLegislationMatterLinksBatchHandler(
          fixture.legislationDb,
        );
        const response = await handler.handler(
          createTestHandlerContext<Parameters<typeof handler.handler>[0]>({
            ...fixture.context,
            body: { items: [item(TARGET_LINKS + 1), item(TARGET_LINKS + 2)] },
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.linked.length !== 2 ||
          response.existing.length !== 0 ||
          response.rejected.length !== 0
        ) {
          return panic("Scaling requires two created provision links");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.linked.length,
        };
      }),
  },
  {
    name: "legislation matter link delete",
    definition: deleteLink,
    expectedRows: 1,
    measure: async (fixture: Fixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await deleteLink.handler(
          createTestHandlerContext<Parameters<typeof deleteLink.handler>[0]>({
            ...fixture.context,
            params: {
              workspaceId: fixture.workspaceId,
              linkId: fixture.linkId,
            },
          }),
        );
        if (response instanceof HttpStatusResponse || !response.success) {
          return panic(
            "Scaling requires deletion of the seeded provision link",
          );
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
];
