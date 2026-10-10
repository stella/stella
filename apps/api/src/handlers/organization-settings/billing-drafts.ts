import { Result } from "better-result";
import { and, eq, gt, ilike, inArray, isNull, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  agentSkillResources,
  agentSkills,
  billingGuidelineFiles,
  contacts,
  organizationSettings,
  AI_BILLING_DRAFTS_MODE,
} from "@/api/db/schema";
import { EDITABLE_AGENT_SKILL_ORIGINS } from "@/api/lib/agent-skills/origin";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  loadBillingGuidelines,
  BILLING_GUIDELINE_MAX_FILES_PER_CLIENT,
} from "@/api/lib/billing/billing-guidelines";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId, tPaginationCursor } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";

const permissions = {
  organizationSettings: ["update"],
} satisfies HandlerConfig["permissions"];
const clientQuerySchema = t.Object({
  clientId: t.Optional(tSafeId("contact")),
});

export const readBillingDraftConfiguration = createSafeRootHandler(
  {
    permissions,
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "auth_plumbing" },
    query: clientQuerySchema,
  },
  async function* ({ safeDb, session, query }) {
    const organizationId = session.activeOrganizationId;
    const settings = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: { aiBillingDraftsMode: true },
        }),
      ),
    );
    const files = yield* Result.await(
      loadBillingGuidelines({
        safeDb,
        organizationId,
        clientIds: query.clientId ? [query.clientId] : [],
      }),
    );
    const client = query.clientId
      ? yield* Result.await(
          safeDb((tx) =>
            tx.query.contacts.findFirst({
              where: {
                id: { eq: query.clientId },
                organizationId: { eq: organizationId },
              },
              columns: { timeBillingFormat: true },
            }),
          ),
        )
      : undefined;
    return Result.ok({
      mode: settings?.aiBillingDraftsMode ?? "disabled",
      files,
      timeBillingFormat: client?.timeBillingFormat ?? "categories",
    });
  },
);

const CONFIGURATION_FAILURES = {
  firm_guideline_required: {
    status: 400,
    message:
      "Attach a firm billing guideline file before enabling AI billing drafts",
  },
  invalid_client: { status: 404, message: "Client not found" },
  invalid_files: {
    status: 400,
    message:
      "Billing guidelines must be team knowledge files in this organization",
  },
} as const;

export const updateBillingDraftConfiguration = createSafeRootHandler(
  {
    permissions,
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "auth_plumbing" },
    body: t.Object(
      {
        mode: t.Optional(t.Enum(AI_BILLING_DRAFTS_MODE)),
        clientId: t.Optional(tSafeId("contact")),
        resourceIds: t.Optional(
          t.Array(tSafeId("agentSkillResource"), {
            maxItems: BILLING_GUIDELINE_MAX_FILES_PER_CLIENT,
            uniqueItems: true,
          }),
        ),
        timeBillingFormat: t.Optional(
          t.Union([t.Literal("categories"), t.Literal("ledes")]),
        ),
      },
      { additionalProperties: false },
    ),
  },
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    if (
      !body.clientId &&
      ((body.resourceIds?.length ?? 0) > 1 ||
        body.timeBillingFormat !== undefined)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "A firm has one billing guideline file; billing format requires a client",
        }),
      );
    }
    const result = yield* Result.await(
      safeDb(async (tx) => {
        if (body.resourceIds && body.resourceIds.length > 0) {
          const resources = await tx
            .select({ id: agentSkillResources.id })
            .from(agentSkillResources)
            .innerJoin(
              agentSkills,
              eq(agentSkills.id, agentSkillResources.skillId),
            )
            .where(
              and(
                eq(agentSkillResources.organizationId, organizationId),
                eq(agentSkills.organizationId, organizationId),
                eq(agentSkills.scope, "team"),
                inArray(agentSkills.origin, EDITABLE_AGENT_SKILL_ORIGINS),
                eq(agentSkillResources.kind, "knowledge"),
                inArray(agentSkillResources.id, body.resourceIds),
              ),
            )
            .limit(BILLING_GUIDELINE_MAX_FILES_PER_CLIENT);
          if (resources.length !== body.resourceIds.length) {
            return { type: "invalid_files" } as const;
          }
        }
        // Serialize attachment replacement and its bound against concurrent admins.
        let orgRows = await tx
          .select({
            id: organizationSettings.id,
            mode: organizationSettings.aiBillingDraftsMode,
          })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId))
          .for("update")
          .limit(1);
        if (orgRows.length === 0) {
          await tx
            .insert(organizationSettings)
            .values({
              id: createSafeId<"organizationSettings">(),
              organizationId,
            })
            .onConflictDoNothing();
          orgRows = await tx
            .select({
              id: organizationSettings.id,
              mode: organizationSettings.aiBillingDraftsMode,
            })
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId))
            .for("update")
            .limit(1);
        }
        let previousClientFormat: string | null = null;
        if (body.clientId) {
          const client = await tx
            .select({ id: contacts.id, format: contacts.timeBillingFormat })
            .from(contacts)
            .where(
              and(
                eq(contacts.organizationId, organizationId),
                eq(contacts.id, body.clientId),
              ),
            )
            .for("update")
            .limit(1);
          if (client.length === 0) {
            return { type: "invalid_client" } as const;
          }
          previousClientFormat = client.at(0)?.format ?? null;
        }
        const oldFiles = await tx
          .select({ resourceId: billingGuidelineFiles.resourceId })
          .from(billingGuidelineFiles)
          .where(
            and(
              eq(billingGuidelineFiles.organizationId, organizationId),
              body.clientId
                ? eq(billingGuidelineFiles.clientId, body.clientId)
                : isNull(billingGuidelineFiles.clientId),
            ),
          )
          .limit(BILLING_GUIDELINE_MAX_FILES_PER_CLIENT);
        const firmFiles = body.clientId
          ? await tx
              .select({ resourceId: billingGuidelineFiles.resourceId })
              .from(billingGuidelineFiles)
              .where(
                and(
                  eq(billingGuidelineFiles.organizationId, organizationId),
                  isNull(billingGuidelineFiles.clientId),
                ),
              )
              .limit(1)
          : oldFiles;
        const nextFirmFiles = body.clientId
          ? firmFiles
          : (body.resourceIds ?? firmFiles);
        if (
          (body.mode ?? orgRows.at(0)?.mode ?? "disabled") === "enabled" &&
          nextFirmFiles.length === 0
        ) {
          return { type: "firm_guideline_required" } as const;
        }
        if (body.mode !== undefined) {
          await tx
            .update(organizationSettings)
            .set({ aiBillingDraftsMode: body.mode })
            .where(eq(organizationSettings.organizationId, organizationId));
        }
        if (body.timeBillingFormat !== undefined && body.clientId) {
          await tx
            .update(contacts)
            .set({ timeBillingFormat: body.timeBillingFormat })
            .where(
              and(
                eq(contacts.id, body.clientId),
                eq(contacts.organizationId, organizationId),
              ),
            );
        }
        if (body.resourceIds !== undefined) {
          await tx
            .delete(billingGuidelineFiles)
            .where(
              and(
                eq(billingGuidelineFiles.organizationId, organizationId),
                body.clientId
                  ? eq(billingGuidelineFiles.clientId, body.clientId)
                  : isNull(billingGuidelineFiles.clientId),
              ),
            );
          if (body.resourceIds.length > 0) {
            await tx.insert(billingGuidelineFiles).values(
              body.resourceIds.map((resourceId) => ({
                organizationId,
                resourceId,
                clientId: body.clientId ?? null,
              })),
            );
          }
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: organizationId,
          changes: {
            ...(body.mode !== undefined
              ? {
                  aiBillingDraftsMode: {
                    old: orgRows.at(0)?.mode ?? "disabled",
                    new: body.mode,
                  },
                }
              : {}),
            ...(body.resourceIds !== undefined
              ? {
                  billingGuidelineResourceIds: {
                    old: oldFiles.map((file) => file.resourceId),
                    new: body.resourceIds,
                  },
                }
              : {}),
            ...(body.timeBillingFormat !== undefined
              ? {
                  timeBillingFormat: {
                    old: previousClientFormat,
                    new: body.timeBillingFormat,
                  },
                }
              : {}),
          },
        });
        return { type: "updated" } as const;
      }),
    );
    if (result.type === "updated") {
      return Result.ok({ updated: true });
    }
    const failure = CONFIGURATION_FAILURES[result.type];
    return Result.err(new HandlerError(failure));
  },
);

export const listBillingKnowledgeFiles = createSafeRootHandler(
  {
    permissions,
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "auth_plumbing" },
    query: t.Object({
      query: t.Optional(t.String({ maxLength: 200 })),
      cursor: t.Optional(tPaginationCursor()),
    }),
  },
  async function* ({ safeDb, session, query }) {
    let afterResourceId: string | null = null;
    if (query.cursor) {
      const parts = decodePaginationCursor(query.cursor);
      const id = parts?.at(0);
      if (parts?.length !== 1 || !isUuidPaginationCursorPart(id)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Invalid knowledge-file cursor",
          }),
        );
      }
      afterResourceId = id;
    }

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkillResources.id,
            path: agentSkillResources.path,
            skillId: agentSkills.id,
            skillName: agentSkills.name,
          })
          .from(agentSkillResources)
          .innerJoin(
            agentSkills,
            eq(agentSkills.id, agentSkillResources.skillId),
          )
          .where(
            and(
              eq(
                agentSkillResources.organizationId,
                session.activeOrganizationId,
              ),
              eq(agentSkills.organizationId, session.activeOrganizationId),
              eq(agentSkills.scope, "team"),
              inArray(agentSkills.origin, EDITABLE_AGENT_SKILL_ORIGINS),
              eq(agentSkillResources.kind, "knowledge"),
              afterResourceId
                ? gt(agentSkillResources.id, sql`${afterResourceId}`)
                : undefined,
              query.query
                ? // sql-perf-allow: index agent_skill_resources_path_billing_trgm_idx
                  ilike(
                    agentSkillResources.path,
                    `%${escapeLike(query.query)}%`,
                  )
                : undefined,
            ),
          )
          .orderBy(agentSkillResources.id)
          .limit(21),
      ),
    );
    return Result.ok(
      createCursorPage({
        rows,
        limit: 20,
        cursorForItem: (file) => encodePaginationCursor([file.id]),
      }),
    );
  },
);

export const readBillingKnowledgeFile = createSafeRootHandler(
  {
    permissions,
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "auth_plumbing" },
    params: t.Object({ resourceId: tSafeId("agentSkillResource") }),
  },
  async function* ({ safeDb, session, params }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ content: agentSkillResources.content })
          .from(agentSkillResources)
          .innerJoin(
            agentSkills,
            eq(agentSkills.id, agentSkillResources.skillId),
          )
          .where(
            and(
              eq(agentSkillResources.id, params.resourceId),
              eq(
                agentSkillResources.organizationId,
                session.activeOrganizationId,
              ),
              eq(agentSkills.organizationId, session.activeOrganizationId),
              eq(agentSkills.scope, "team"),
              eq(agentSkillResources.kind, "knowledge"),
            ),
          )
          .limit(1),
      ),
    );
    const file = rows.at(0);
    if (!file) {
      return Result.err(
        new HandlerError({ status: 404, message: "Knowledge file not found" }),
      );
    }
    return Result.ok(file);
  },
);
