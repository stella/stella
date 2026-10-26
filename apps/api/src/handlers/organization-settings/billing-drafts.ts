import { panic, Result } from "better-result";
import { and, eq, gt, ilike, inArray, isNull, like, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import { abortableTx, abortTransaction } from "@/api/db/safe-db";
import {
  agentSkillResources,
  agentSkills,
  AI_BILLING_DRAFTS_MODE,
  billingGuidelineFiles,
  contacts,
  organizationSettings,
} from "@/api/db/schema";
import { EDITABLE_AGENT_SKILL_ORIGINS } from "@/api/lib/agent-skills/origin";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  BILLING_GUIDELINE_MAX_FILES_PER_CLIENT,
  loadBillingGuidelines,
} from "@/api/lib/billing/billing-guidelines";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  paginationCursorSchema,
  resourceIdSchema,
  uniqueItems,
} from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { expectedUpdatedAtSchema } from "@/api/lib/optimistic-concurrency";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { enforceWritePrecondition } from "@/api/lib/write-contract/write-contract";

const BILLING_KNOWLEDGE_FILES_PAGE_SIZE = 20;

const permissions = {
  organizationSettings: ["update"],
} satisfies HandlerConfig["permissions"];
const clientQuerySchema = v.object({
  clientId: v.optional(resourceIdSchema("contact")),
});

export const readBillingDraftConfiguration = createSafeRootHandler(
  {
    contract: "patch",
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
          columns: { aiBillingDraftsMode: true, updatedAt: true },
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
      updatedAt: (settings?.updatedAt ?? new Date(0)).toISOString(),
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
  stale: {
    status: 409,
    message: "Billing draft settings changed; reload and try again",
  },
} as const;

type ResourceValidationOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  resourceIds: SafeId<"agentSkillResource">[];
};

const validateBillingResources = async ({
  tx,
  organizationId,
  resourceIds,
}: ResourceValidationOptions) => {
  if (resourceIds.length === 0) {
    return true;
  }
  const resources = await readBounded(
    tx
      .select({ id: agentSkillResources.id })
      .from(agentSkillResources)
      .innerJoin(agentSkills, eq(agentSkills.id, agentSkillResources.skillId))
      .where(
        and(
          eq(agentSkillResources.organizationId, organizationId),
          eq(agentSkills.organizationId, organizationId),
          eq(agentSkills.scope, "team"),
          inArray(agentSkills.origin, EDITABLE_AGENT_SKILL_ORIGINS),
          like(agentSkillResources.path, "references/%"),
          inArray(agentSkillResources.id, resourceIds),
        ),
      ),
    BILLING_GUIDELINE_MAX_FILES_PER_CLIENT,
  );
  return (
    resources.type === "complete" &&
    resources.rows.length === resourceIds.length
  );
};

type BillingFileBindingOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  clientId?: SafeId<"contact">;
};

const loadBillingFileBindings = async ({
  tx,
  organizationId,
  clientId,
}: BillingFileBindingOptions) => {
  const bindings = await readBounded(
    tx
      .select({ resourceId: billingGuidelineFiles.resourceId })
      .from(billingGuidelineFiles)
      .where(
        and(
          eq(billingGuidelineFiles.organizationId, organizationId),
          clientId
            ? eq(billingGuidelineFiles.clientId, clientId)
            : isNull(billingGuidelineFiles.clientId),
        ),
      ),
    BILLING_GUIDELINE_MAX_FILES_PER_CLIENT,
  );
  const oldFiles =
    bindings.type === "complete"
      ? bindings.rows
      : panic("Billing guideline bindings exceed their configured cap", {
          organizationId,
          clientId,
        });
  const firmFiles = clientId
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
  return { oldFiles, firmFiles };
};

const billingDraftConfigurationBodySchema = v.strictObject({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  mode: v.optional(v.enum(AI_BILLING_DRAFTS_MODE)),
  clientId: v.optional(resourceIdSchema("contact")),
  resourceIds: v.optional(
    v.pipe(
      v.array(resourceIdSchema("agentSkillResource")),
      v.maxLength(BILLING_GUIDELINE_MAX_FILES_PER_CLIENT),
      uniqueItems(),
    ),
  ),
  timeBillingFormat: v.optional(
    v.union([v.literal("categories"), v.literal("ledes")]),
  ),
});

type BillingDraftAuditChangesOptions = {
  body: v.InferOutput<typeof billingDraftConfigurationBodySchema>;
  previousMode: v.InferOutput<
    typeof billingDraftConfigurationBodySchema
  >["mode"];
  previousResourceIds: SafeId<"agentSkillResource">[];
  previousClientFormat: string | null;
};

const billingDraftAuditChanges = ({
  body,
  previousMode,
  previousResourceIds,
  previousClientFormat,
}: BillingDraftAuditChangesOptions) => ({
  ...(body.mode !== undefined
    ? {
        aiBillingDraftsMode: {
          old: previousMode ?? "disabled",
          new: body.mode,
        },
      }
    : {}),
  ...(body.resourceIds !== undefined
    ? {
        billingGuidelineResourceIds: {
          old: previousResourceIds,
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
});

export const updateBillingDraftConfiguration = createSafeRootHandler(
  {
    // Each field sent replaces only its own value (the mode, one client's
    // guideline set, that client's format); absent fields stay unchanged.
    contract: "patch",
    permissions,
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "auth_plumbing" },
    body: billingDraftConfigurationBodySchema,
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
      abortableTx(safeDb, async (tx) => {
        await withAggregateLock({
          aggregate: "organization",
          id: organizationId,
          tx,
          mode: "update",
        });
        if (
          body.resourceIds !== undefined &&
          !(await validateBillingResources({
            tx,
            organizationId,
            resourceIds: body.resourceIds,
          }))
        ) {
          return { type: "invalid_files" } as const;
        }
        const settingsRow = (
          await tx
            .select({
              id: organizationSettings.id,
              mode: organizationSettings.aiBillingDraftsMode,
              updatedAt: organizationSettings.updatedAt,
              updatedAtToken: timestampCasToken(organizationSettings.updatedAt),
            })
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId))
            .limit(1)
        ).at(0);
        let previousClientFormat:
          (typeof contacts.$inferSelect)["timeBillingFormat"] | null = null;
        if (body.clientId) {
          const client = (
            await tx
              .select({ id: contacts.id, format: contacts.timeBillingFormat })
              .from(contacts)
              .where(
                and(
                  eq(contacts.organizationId, organizationId),
                  eq(contacts.id, body.clientId),
                ),
              )
              .limit(1)
          ).at(0);
          if (client === undefined) {
            return { type: "invalid_client" } as const;
          }
          previousClientFormat = client.format;
        }
        const { oldFiles, firmFiles } = await loadBillingFileBindings({
          tx,
          organizationId,
          ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
        });
        const nextFirmFiles = body.clientId
          ? firmFiles
          : (body.resourceIds ?? firmFiles);
        if (
          (body.mode ?? settingsRow?.mode ?? "disabled") === "enabled" &&
          nextFirmFiles.length === 0
        ) {
          return { type: "firm_guideline_required" } as const;
        }
        if (
          enforceWritePrecondition({
            type: "updatedAt",
            field: "expectedUpdatedAt",
            storedUpdatedAt: settingsRow?.updatedAt ?? new Date(0),
            expectedUpdatedAt: body.expectedUpdatedAt,
            resource: "Billing draft settings",
          })
        ) {
          return { type: "stale" } as const;
        }
        const updatedAt = new Date();
        const claimedSettings = settingsRow
          ? (
              await tx
                .update(organizationSettings)
                .set({
                  ...(body.mode === undefined
                    ? {}
                    : { aiBillingDraftsMode: body.mode }),
                  updatedAt,
                })
                .where(
                  and(
                    eq(organizationSettings.id, settingsRow.id),
                    eq(organizationSettings.organizationId, organizationId),
                    timestampMatchesCasToken(
                      organizationSettings.updatedAt,
                      settingsRow.updatedAtToken,
                    ),
                  ),
                )
                .returning({ updatedAt: organizationSettings.updatedAt })
            ).at(0)
          : (
              await tx
                .insert(organizationSettings)
                .values({
                  id: createSafeId<"organizationSettings">(),
                  organizationId,
                  ...(body.mode === undefined
                    ? {}
                    : { aiBillingDraftsMode: body.mode }),
                  updatedAt,
                })
                .onConflictDoNothing()
                .returning({ updatedAt: organizationSettings.updatedAt })
            ).at(0);
        if (!claimedSettings) {
          return abortTransaction(
            new HandlerError(CONFIGURATION_FAILURES.stale),
          );
        }
        if (body.timeBillingFormat !== undefined && body.clientId) {
          const updatedClients = await tx
            .update(contacts)
            .set({ timeBillingFormat: body.timeBillingFormat })
            .where(
              and(
                eq(contacts.id, body.clientId),
                eq(contacts.organizationId, organizationId),
                previousClientFormat === null
                  ? isNull(contacts.timeBillingFormat)
                  : eq(contacts.timeBillingFormat, previousClientFormat),
              ),
            )
            .returning({ id: contacts.id });
          if (updatedClients.length === 0) {
            return abortTransaction(
              new HandlerError(CONFIGURATION_FAILURES.stale),
            );
          }
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
          changes: billingDraftAuditChanges({
            body,
            previousMode: settingsRow?.mode,
            previousResourceIds: oldFiles.map(({ resourceId }) => resourceId),
            previousClientFormat,
          }),
        });
        return {
          type: "updated",
          updatedAt: claimedSettings.updatedAt,
        } as const;
      }),
    );
    if (result.type === "updated") {
      return Result.ok({
        updated: true,
        updatedAt: result.updatedAt.toISOString(),
      });
    }
    const failure = CONFIGURATION_FAILURES[result.type];
    return Result.err(new HandlerError(failure));
  },
);

declareAggregateMutation(updateBillingDraftConfiguration, {
  type: "aggregate",
  aggregates: ["organization"],
});

export const listBillingKnowledgeFiles = createSafeRootHandler(
  {
    contract: "patch",
    permissions,
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "auth_plumbing" },
    query: v.object({
      query: v.optional(v.pipe(v.string(), v.maxLength(200))),
      cursor: v.optional(paginationCursorSchema()),
    }),
  },
  async function* ({ safeDb, session, query }) {
    const cursorParts = query.cursor
      ? decodePaginationCursor(query.cursor)
      : null;
    const afterResourceId = cursorParts?.at(0);
    if (
      query.cursor &&
      (cursorParts?.length !== 1 ||
        !isUuidPaginationCursorPart(afterResourceId))
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Invalid knowledge-file cursor",
        }),
      );
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
              like(agentSkillResources.path, "references/%"),
              afterResourceId !== undefined
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
          .limit(BILLING_KNOWLEDGE_FILES_PAGE_SIZE + 1),
      ),
    );
    return Result.ok(
      createCursorPage({
        rows,
        limit: BILLING_KNOWLEDGE_FILES_PAGE_SIZE,
        cursorForItem: (file) => encodePaginationCursor([file.id]),
      }),
    );
  },
);

export const readBillingKnowledgeFile = createSafeRootHandler(
  {
    contract: "patch",
    permissions,
    accountAccess: ACCOUNT_ACCESS.accountControl,
    mcp: { type: "internal", reason: "auth_plumbing" },
    params: v.object({ resourceId: resourceIdSchema("agentSkillResource") }),
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
              like(agentSkillResources.path, "references/%"),
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
