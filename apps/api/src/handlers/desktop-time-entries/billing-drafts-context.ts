import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { DesktopBillingDraftRequest } from "@stll/api-contract/desktop-billing-drafts";
import { DESKTOP_BILLING_DRAFT_LIMITS } from "@stll/api-contract/desktop-billing-drafts";
import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  billingDraftUserSettings,
  contacts,
  organizationSettings,
} from "@/api/db/schema";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { loadBillingGuidelines } from "@/api/lib/billing/billing-guidelines";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandValidatedWorkspaceId } from "@/api/lib/safe-id-boundaries";

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
  "safeDb" | "organizationId"
> & { matterIds: SafeId<"workspace">[] };

const loadBillingDraftMatters = async ({
  safeDb,
  organizationId,
  matterIds,
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
      safeDb((tx) =>
        tx.query.workspaces.findMany({
          where: {
            organizationId: { eq: organizationId },
            status: { eq: "active" },
          },
          columns: {
            id: true,
            name: true,
            clientId: true,
            billingNarrativeLanguage: true,
          },
          orderBy: { lastActivityAt: "desc", id: "asc" },
          limit: BILLING_DRAFT_CONTEXT_LIMITS.candidateMatters,
        }),
      ),
    );
    const matterRows = Array.from(
      new Map(
        [...selected, ...candidates].map((row) => [row.id, row]),
      ).values(),
    );
    const allClientIds = Array.from(
      new Set(
        matterRows.flatMap(({ clientId }) => (clientId ? [clientId] : [])),
      ),
    );
    const formats =
      allClientIds.length === 0
        ? []
        : yield* Result.await(
            safeDb((tx) =>
              tx
                .select({ id: contacts.id, format: contacts.timeBillingFormat })
                .from(contacts)
                .where(
                  and(
                    eq(contacts.organizationId, organizationId),
                    inArray(contacts.id, allClientIds),
                  ),
                )
                .limit(allClientIds.length),
            ),
          );
    const formatsById = new Map(formats.map(({ id, format }) => [id, format]));
    const matters = matterRows.map(
      ({ id, name, clientId, billingNarrativeLanguage }) => {
        const format =
          clientId === null ? "categories" : formatsById.get(clientId);
        if (format === undefined) {
          return panic("Matter billing client is inaccessible");
        }
        return {
          matterId: id,
          name,
          clientId,
          narrativeLanguage: billingNarrativeLanguage,
          ledesEnabled: format === "ledes",
        };
      },
    );
    return Result.ok({ selected, matters });
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
          .where(eq(billingDraftUserSettings.userId, userId))
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
    const { selected, matters } = yield* Result.await(
      loadBillingDraftMatters({
        safeDb,
        organizationId,
        matterIds: validatedMatterIds,
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
          // Text before the first heading is an independently citable section.
          sections: [
            "Preamble",
            ...Array.from(
              file.content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu),
              (match) => match[1] ?? panic("Heading has no capture"),
            ),
          ],
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
