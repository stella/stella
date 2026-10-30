import { panic, Result } from "better-result";
import { and, desc, eq, sql } from "drizzle-orm";

import type { DesktopBillingDraftRequest } from "@stll/api-contract/desktop-billing-drafts";
import { DESKTOP_BILLING_DRAFT_LIMITS } from "@stll/api-contract/desktop-billing-drafts";
import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  billingDraftUserSettings,
  organizationSettings,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import {
  extractBillingGuidelineSections,
  loadBillingGuidelines,
} from "@/api/lib/billing/billing-guidelines";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandValidatedWorkspaceId } from "@/api/lib/safe-id-boundaries";

import { loadMatterLedes } from "./matter-classification";

export const BILLING_DRAFT_CONTEXT_LIMITS = {
  historyDays: 90,
  earlierEntries: 200,
  candidateMatters: 20,
  promptCharacters: 100_000,
  timeoutMs: 60_000,
} as const;

type LoadBillingDraftContextOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  body: DesktopBillingDraftRequest;
};

type LoadBillingDraftMattersOptions = Pick<
  LoadBillingDraftContextOptions,
  "safeDb" | "organizationId" | "userId"
> & { matterIds: SafeId<"workspace">[] };

const loadBillingDraftMatters = async ({
  safeDb,
  organizationId,
  matterIds,
  userId,
}: LoadBillingDraftMattersOptions) =>
  await Result.gen(async function* () {
    const selected = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaces.findMany({
          where: {
            id: { in: matterIds },
            organizationId: { eq: organizationId },
            status: { eq: "active" },
          },
          columns: {
            id: true,
            name: true,
            clientId: true,
            billingNarrativeLanguage: true,
          },
          limit: matterIds.length,
        }),
      ),
    );
    if (selected.length !== matterIds.length) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Selected matter is unavailable",
        }),
      );
    }
    const candidates = yield* Result.await(
      safeDb((tx) => {
        // Aggregate only the caller's work; firm activity must never select names for this prompt.
        const ownActivity = tx
          .select({
            matterId: timeEntries.workspaceId,
            at: sql<string>`max(${timeEntries.createdAt})`.as("at"),
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.organizationId, organizationId),
              eq(timeEntries.userId, userId),
            ),
          )
          .groupBy(timeEntries.workspaceId)
          .unionAll(
            tx
              .select({
                matterId: auditLogs.workspaceId,
                at: sql<string>`max(${auditLogs.createdAt})`.as("at"),
              })
              .from(auditLogs)
              .where(
                and(
                  eq(auditLogs.organizationId, organizationId),
                  eq(auditLogs.performerType, "user"),
                  sql`coalesce(${auditLogs.performerId}, ${auditLogs.userId}) = ${userId}`,
                ),
              )
              .groupBy(auditLogs.workspaceId),
          )
          .as("own_activity");
        return tx
          .select({
            id: workspaces.id,
            name: workspaces.name,
            clientId: workspaces.clientId,
            billingNarrativeLanguage: workspaces.billingNarrativeLanguage,
          })
          .from(workspaces)
          .innerJoin(ownActivity, eq(ownActivity.matterId, workspaces.id))
          .where(
            and(
              eq(workspaces.organizationId, organizationId),
              eq(workspaces.status, "active"),
            ),
          )
          .groupBy(workspaces.id)
          .orderBy(desc(sql`max(${ownActivity.at})`), workspaces.id)
          .limit(BILLING_DRAFT_CONTEXT_LIMITS.candidateMatters);
      }),
    );
    const matterRows = Array.from(
      new Map(
        [...selected, ...candidates].map((row) => [row.id, row]),
      ).values(),
    );
    const ledesByMatter = yield* Result.await(
      safeDb(
        async (tx) =>
          await loadMatterLedes(tx, { organizationId, matters: matterRows }),
      ),
    );
    const matters = matterRows.map(
      ({ id, name, clientId, billingNarrativeLanguage }) => ({
        matterId: id,
        name,
        clientId,
        narrativeLanguage: billingNarrativeLanguage,
        ledesEnabled:
          ledesByMatter.get(id) ?? panic("Billing draft matter disappeared"),
      }),
    );
    return Result.ok({
      selected,
      matters,
      moveTargetMatterIds: candidates.map(({ id }) => id),
    });
  });

export const loadBillingDraftContext = async ({
  safeDb,
  organizationId,
  userId,
  body,
}: LoadBillingDraftContextOptions) =>
  await Result.gen(async function* () {
    const settings = yield* Result.await(
      safeDb(async (tx) => {
        const org = await tx
          .select({ mode: organizationSettings.aiBillingDraftsMode })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId))
          .limit(1);
        const own = await tx
          .select({
            consentAt: billingDraftUserSettings.consentAt,
            preference: billingDraftUserSettings.preference,
          })
          .from(billingDraftUserSettings)
          .where(
            and(
              eq(billingDraftUserSettings.organizationId, organizationId),
              eq(billingDraftUserSettings.userId, userId),
            ),
          )
          .limit(1);
        return { org: org.at(0), own: own.at(0) };
      }),
    );
    if (settings.org?.mode !== "enabled" || !settings.own?.consentAt) {
      return Result.err(
        new HandlerError({
          status: 403,
          message:
            "AI billing drafts require organization enablement and personal consent",
        }),
      );
    }
    const matterIds = Array.from(
      new Set(
        body.entries.map(({ matterId }) => brandValidatedWorkspaceId(matterId)),
      ),
    );
    if (matterIds.some((id) => id === null)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Matter identifier is invalid",
        }),
      );
    }
    const validatedMatterIds = matterIds.filter((id) => id !== null);
    const { selected, matters, moveTargetMatterIds } = yield* Result.await(
      loadBillingDraftMatters({
        safeDb,
        organizationId,
        matterIds: validatedMatterIds,
        userId,
      }),
    );
    const clientIds = Array.from(
      new Set(selected.flatMap(({ clientId }) => (clientId ? [clientId] : []))),
    );
    const windowEnd = Temporal.Now.plainDateISO().toString();
    const windowStart = Temporal.PlainDate.from(windowEnd)
      .subtract({ days: BILLING_DRAFT_CONTEXT_LIMITS.historyDays })
      .toString();
    const earlierEntries = yield* Result.await(
      safeDb((tx) =>
        tx.query.timeEntries.findMany({
          where: {
            organizationId: { eq: organizationId },
            userId: { eq: userId },
            workspaceId: { in: validatedMatterIds },
            dateWorked: { gte: windowStart, lte: windowEnd },
          },
          columns: {
            id: true,
            workspaceId: true,
            dateWorked: true,
            durationMinutes: true,
            narrative: true,
            taskCode: true,
            activityCode: true,
            activityGroup: true,
          },
          orderBy: { dateWorked: "desc", id: "desc" },
          limit: BILLING_DRAFT_CONTEXT_LIMITS.earlierEntries,
        }),
      ),
    );
    const files = yield* Result.await(
      loadBillingGuidelines({ safeDb, organizationId, clientIds }),
    );
    if (!files.some(({ clientId }) => clientId === null)) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "A firm billing guideline file is required",
        }),
      );
    }
    const guidelines = Array.from(
      new Set(files.map(({ fileId }) => fileId)),
      (fileId) => {
        const bindings = files.filter((file) => file.fileId === fileId);
        const file = bindings.at(0);
        if (!file) {
          return panic("Guideline binding disappeared");
        }
        return {
          ...file,
          sections: extractBillingGuidelineSections(file.content),
          ...(bindings.some(({ clientId }) => clientId === null)
            ? {}
            : {
                matterIds: selected
                  .filter(({ clientId }) =>
                    bindings.some((binding) => binding.clientId === clientId),
                  )
                  .map(({ id }) => id),
              }),
        };
      },
    );
    if (guidelines.length > DESKTOP_BILLING_DRAFT_LIMITS.guidelines) {
      return Result.err(
        new HandlerError({
          status: 413,
          message: "Too many billing guideline files in the selected context",
        }),
      );
    }
    const loadedAISettings = yield* Result.await(
      safeDb(
        async (tx) => await loadOrgAISettings(tx, { organizationId, userId }),
      ),
    );
    const aiSettings = yield* loadedAISettings;
    return Result.ok({
      matters,
      moveTargetMatterIds,
      earlierEntries: earlierEntries.map((entry) => ({
        id: entry.id,
        dateWorked: entry.dateWorked,
        durationMinutes: entry.durationMinutes,
        narrative: entry.narrative,
        taskCode: entry.taskCode,
        activityCode: entry.activityCode,
        activityGroup: entry.activityGroup,
        matterId:
          entry.workspaceId ??
          panic("Matter-scoped history returned an internal entry"),
      })),
      guidelines,
      preference: settings.own.preference,
      ...aiSettings,
    });
  });
