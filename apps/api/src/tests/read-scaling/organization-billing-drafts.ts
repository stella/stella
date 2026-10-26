import { panic } from "better-result";
import { expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization } from "@/api/db/auth-schema";
import {
  agentSkillResources,
  agentSkills,
  billingGuidelineFiles,
  contacts,
  organizationSettings,
} from "@/api/db/schema";
import {
  listBillingKnowledgeFiles,
  readBillingDraftConfiguration,
  readBillingKnowledgeFile,
} from "@/api/handlers/organization-settings/billing-drafts";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";

type ReadFixture = Awaited<ReturnType<typeof seedEntityReadScaling>>;
type BillingKnowledgeState = {
  clientId: SafeId<"contact">;
  files: Pick<
    typeof agentSkillResources.$inferSelect,
    "id" | "path" | "content"
  >[];
  skillId: SafeId<"agentSkill">;
  updatedAt: Date;
};

const withBillingKnowledgeFixture = async <TResult>(
  fixture: ReadFixture,
  measure: (state: BillingKnowledgeState) => Promise<TResult>,
) => {
  const { db, organizationId, userId, size } = fixture;
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const clientId = createSafeId<"contact">();
  const skillId = createSafeId<"agentSkill">();
  const privateSkillId = createSafeId<"agentSkill">();
  const foreignSkillId = createSafeId<"agentSkill">();
  const membershipId = Bun.randomUUIDv7();
  const updatedAt = new Date("2026-10-01T12:00:00.000Z");
  const noiseBindings = [
    {
      organizationId: otherOrganizationId,
      skillId: foreignSkillId,
      directory: "references",
    },
    { organizationId, skillId: privateSkillId, directory: "references" },
    { organizationId, skillId, directory: "assets" },
  ];
  const noise = Array.from({ length: size }, (_, index) => {
    const { directory, ...binding } =
      noiseBindings.at(index % noiseBindings.length) ??
      panic("Billing noise binding is missing");
    return {
      id: createSafeId<"agentSkillResource">(),
      ...binding,
      path: `${directory}/noise-${index}.md`,
      content: "Unrelated content".repeat(size),
    };
  });
  // The visible page stays fixed even in the ten-row fixture. Earlier decoys
  // exercise tenant, team scope and reference-path filtering before LIMIT.
  const files = Array.from({ length: 20 }, (_, index) => ({
    id: createSafeId<"agentSkillResource">(),
    path: `references/billing-${index}.md`,
    content: `# Billing ${index}\nDescribe the work performed.`,
  }));
  try {
    await db.insert(organization).values({
      id: otherOrganizationId,
      name: "Other billing organization",
      slug: otherOrganizationId,
      createdAt: updatedAt,
    });
    await db.insert(member).values({
      id: membershipId,
      organizationId,
      userId,
      role: "owner",
      createdAt: updatedAt,
    });
    await db.insert(contacts).values({
      id: clientId,
      organizationId,
      type: "organization",
      organizationName: "Billing client",
      displayName: "Billing client",
      timeBillingFormat: "ledes",
    });
    await db.insert(agentSkills).values(
      [
        {
          id: foreignSkillId,
          organizationId: otherOrganizationId,
          scope: "team" as const,
        },
        { id: privateSkillId, organizationId, scope: "private" as const },
        { id: skillId, organizationId, scope: "team" as const },
      ].map((entry) => ({
        ...entry,
        userId,
        origin: "authored" as const,
        slug: entry.id,
        name: "Billing guidance",
        description: "Fixture guidance",
        contentHash: "0".repeat(64),
        body: "# Billing guidance",
      })),
    );
    await db.insert(agentSkillResources).values(
      [
        ...noise,
        ...files.map((file) => ({ ...file, organizationId, skillId })),
      ].map((file) => ({
        ...file,
        sizeBytes: Buffer.byteLength(file.content),
      })),
    );
    const firmFile =
      files.at(0) ?? panic("Billing fixture requires a firm file");
    const clientFile =
      files.at(1) ?? panic("Billing fixture requires a client file");
    await db.insert(organizationSettings).values([
      {
        id: createSafeId<"organizationSettings">(),
        organizationId: otherOrganizationId,
        aiBillingDraftsMode: "disabled",
        updatedAt,
      },
      {
        id: createSafeId<"organizationSettings">(),
        organizationId,
        aiBillingDraftsMode: "enabled",
        updatedAt,
      },
    ]);
    await db.insert(billingGuidelineFiles).values([
      {
        organizationId: otherOrganizationId,
        resourceId: noise.at(0)?.id ?? panic("Billing fixture requires noise"),
        clientId: null,
      },
      { organizationId, resourceId: firmFile.id, clientId: null },
      { organizationId, resourceId: clientFile.id, clientId },
    ]);
    return await measure({ clientId, files, skillId, updatedAt });
  } finally {
    const organizations = [organizationId, otherOrganizationId];
    await db
      .delete(billingGuidelineFiles)
      .where(inArray(billingGuidelineFiles.organizationId, organizations));
    await db
      .delete(agentSkillResources)
      .where(inArray(agentSkillResources.organizationId, organizations));
    await db
      .delete(agentSkills)
      .where(inArray(agentSkills.organizationId, organizations));
    await db.delete(contacts).where(eq(contacts.id, clientId));
    await db
      .delete(organizationSettings)
      .where(inArray(organizationSettings.organizationId, organizations));
    await db.delete(member).where(eq(member.id, membershipId));
    await db
      .delete(organization)
      .where(eq(organization.id, otherOrganizationId));
  }
};

export const measureBillingDraftConfiguration = async (fixture: ReadFixture) =>
  await withBillingKnowledgeFixture(
    fixture,
    async ({ clientId, files, updatedAt }) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await readBillingDraftConfiguration.handler(
          asTestRaw<
            Parameters<typeof readBillingDraftConfiguration.handler>[0]
          >({
            safeDb: fixture.safeDb,
            user: { id: fixture.userId },
            session: { activeOrganizationId: fixture.organizationId },
            memberRole: sessionMemberRole("owner"),
            query: { clientId },
            request: new Request(
              "https://example.test/v1/organization-settings/billing-drafts",
            ),
            route:
              "/v1/organization-settings/billing-drafts" satisfies ApiRoutePath,
          }),
        );
        if (response instanceof HttpStatusResponse) {
          return panic("Billing configuration scaling requires success");
        }
        expect(response.mode).toBe("enabled");
        expect(response.updatedAt).toBe(updatedAt.toISOString());
        expect(response.timeBillingFormat).toBe("ledes");
        expect(response.files).toHaveLength(2);
        for (const [index, file] of files.slice(0, 2).entries()) {
          expect(
            response.files.find(({ fileId }) => fileId === file.id),
          ).toEqual({
            fileId: file.id,
            fileName: file.path,
            content: file.content,
            clientId: index === 0 ? null : clientId,
          });
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  );

export const measureBillingKnowledgeFiles = async (fixture: ReadFixture) =>
  await withBillingKnowledgeFixture(
    fixture,
    async ({ files, skillId }) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listBillingKnowledgeFiles.handler(
          asTestRaw<Parameters<typeof listBillingKnowledgeFiles.handler>[0]>({
            safeDb: fixture.safeDb,
            user: { id: fixture.userId },
            session: { activeOrganizationId: fixture.organizationId },
            memberRole: sessionMemberRole("owner"),
            query: {},
            request: new Request(
              "https://example.test/v1/organization-settings/billing-drafts/knowledge-files",
            ),
            route:
              "/v1/organization-settings/billing-drafts/knowledge-files" satisfies ApiRoutePath,
          }),
        );
        if (response instanceof HttpStatusResponse) {
          return panic("Billing file page scaling requires success");
        }
        expect(response.items.map(({ id }) => id).toSorted()).toEqual(
          files.map(({ id }) => id).toSorted(),
        );
        expect(
          response.items.every(
            (file) =>
              file.skillId === skillId && file.skillName === "Billing guidance",
          ),
        ).toBe(true);
        expect(response.nextCursor).toBeNull();
        expect(response.limit).toBe(20);
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.items.length,
        };
      }),
  );

export const measureBillingKnowledgeFile = async (fixture: ReadFixture) =>
  await withBillingKnowledgeFixture(
    fixture,
    async ({ files }) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const file =
          files.at(0) ?? panic("Billing fixture requires a content file");
        const response = await readBillingKnowledgeFile.handler(
          asTestRaw<Parameters<typeof readBillingKnowledgeFile.handler>[0]>({
            safeDb: fixture.safeDb,
            user: { id: fixture.userId },
            session: { activeOrganizationId: fixture.organizationId },
            memberRole: sessionMemberRole("owner"),
            params: { resourceId: file.id },
            request: new Request(
              `https://example.test/v1/organization-settings/billing-drafts/knowledge-files/${file.id}`,
            ),
            route:
              "/v1/organization-settings/billing-drafts/knowledge-files/:resourceId" satisfies ApiRoutePath,
          }),
        );
        if (response instanceof HttpStatusResponse) {
          return panic("Billing content scaling requires success");
        }
        expect(response).toEqual({ content: file.content });
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  );
