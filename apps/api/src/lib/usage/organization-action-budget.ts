import { panic } from "better-result";
import { and, eq, isNotNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  ACTION_SERVICE_CREDENTIALS,
  type ActionKind,
  type ActionServiceCredentials,
} from "@/api/lib/rate-limit/action-kinds";
import {
  PER_KIND_PERIOD_SCOPE,
  type ActionPeriodPolicy,
  type ActionPeriodScope,
} from "@/api/lib/rate-limit/action-period-budget";
import {
  readFreeTier,
  type FreeTier,
  type OrganizationAccess,
} from "@/api/lib/usage/organization-access";
import {
  readOrganizationAccessSnapshot,
  type OrganizationAccessSnapshot,
} from "@/api/lib/usage/organization-access-snapshot";

/** Whose model key serves the organization's model dispatch. */
export const ORGANIZATION_MODEL_CREDENTIALS = {
  organization: "organization",
  managed: "managed",
} as const;

export type OrganizationModelCredentials =
  (typeof ORGANIZATION_MODEL_CREDENTIALS)[keyof typeof ORGANIZATION_MODEL_CREDENTIALS];

/** What admission reads once per action to resolve the organization's budget. */
export type OrganizationActionState = {
  snapshot: OrganizationAccessSnapshot | undefined;
  freeTier: FreeTier;
  modelCredentials: OrganizationModelCredentials;
};

export type OrganizationActionBudgetConfig = {
  periodMs: number | undefined;
  evaluationActions: number | undefined;
  selfManagedActions: number | undefined;
};

type ActionDrawsServiceBudgetOptions = {
  access: OrganizationAccess;
  serviceCredentials: ActionServiceCredentials;
  modelCredentials: OrganizationModelCredentials;
};

/**
 * Whether an admitted action draws from the organization's service budget.
 * On the free floor the budget covers managed work only: model work served
 * by the organization's own key is not counted. Every other standing counts
 * every service action, whichever key serves it.
 */
export const actionDrawsServiceBudget = ({
  access,
  serviceCredentials,
  modelCredentials,
}: ActionDrawsServiceBudgetOptions): boolean => {
  switch (access.type) {
    case "free":
      return !(
        serviceCredentials === ACTION_SERVICE_CREDENTIALS.organizationModel &&
        modelCredentials === ORGANIZATION_MODEL_CREDENTIALS.organization
      );
    case "paid":
    case "evaluation":
    case "self_managed_keys":
    case "ended":
    case "unavailable":
      return true;
    default:
      access satisfies never;
      return panic("Unhandled organization access");
  }
};

/**
 * What the free floor offers an organization without its own model key, per
 * kind. `off`: a helper the plan does not offer; admission refuses it before
 * any model call. `counts`: offered; a service-consuming kind draws the
 * pooled free budget (background kinds through their counted parent).
 */
export const FREE_WITHOUT_OWN_KEY = {
  "chat.send": "counts",
  "chat.span-edit": "counts",
  // The automatic title of a counted chat send rides on that send.
  "chat.generate-thread-title": "counts",
  "chat.improve-prompt": "counts",
  "chat.suggest-thread-title": "off",
  "chat.suggested-prompts": "off",
  "chat.thread-recap": "off",
  "chat.background": "counts",
  "workflow.start": "counts",
  "flow.start": "counts",
  "workflow.background": "counts",
  "flow.background": "counts",
  "editor.autocomplete": "off",
  "contacts.extract-power-of-attorney": "counts",
  "clauses.rewrite": "counts",
  "templates.prefill": "counts",
  "templates.suggest-fields": "off",
  "templates.fill": "counts",
  "skills.rewrite-resource": "counts",
  "skills.generate-draft": "counts",
  "skills.propose-from-comments": "counts",
  "time-entries.polish-narrative": "counts",
  "entities.suggest-placements": "off",
  "versions.summarize": "counts",
  "properties.suggest-prompt": "off",
  "properties.preview": "counts",
  "search.refine": "counts",
  "search.summarize": "counts",
  "playbooks.derive-ask": "counts",
  "case-law.analysis": "counts",
  "case-law.search-refine": "counts",
  "case-law.search-expand": "counts",
  "case-law.research-answers": "counts",
  "documents.bounding-boxes": "counts",
  "documents.scan-deadlines": "counts",
  "document-reviews.parties": "counts",
  "document-reviews.propose-positions": "counts",
  "document-reviews.start": "counts",
  "document-reviews.background": "counts",
  "document-translation.start": "counts",
  "document-translation.background": "counts",
  "bilingual.prepare": "counts",
  "bilingual.start": "counts",
  "bilingual.background": "counts",
  "list-verification.start": "counts",
  "list-verification.background": "counts",
  "report-export.start": "counts",
  "report-export.background": "counts",
  "mcp.services/call": "counts",
  "mcp.data/call": "counts",
} as const satisfies Record<ActionKind, "counts" | "off">;

export type ActionPlanAvailability = "offered" | "not_on_plan";

type ActionPlanAvailabilityOptions = {
  access: OrganizationAccess;
  actionKind: ActionKind;
  modelCredentials: OrganizationModelCredentials;
};

/** Whether the organization's standing offers this kind at all. */
export const actionPlanAvailability = ({
  access,
  actionKind,
  modelCredentials,
}: ActionPlanAvailabilityOptions): ActionPlanAvailability => {
  switch (access.type) {
    case "free":
      return modelCredentials === ORGANIZATION_MODEL_CREDENTIALS.managed &&
        FREE_WITHOUT_OWN_KEY[actionKind] === "off"
        ? "not_on_plan"
        : "offered";
    case "paid":
    case "evaluation":
    case "self_managed_keys":
    case "ended":
    case "unavailable":
      return "offered";
    default:
      access satisfies never;
      return panic("Unhandled organization access");
  }
};

type ResolveOrganizationActionBudgetOptions = {
  access: OrganizationAccess;
} & OrganizationActionBudgetConfig;

type OrganizationActionBudget =
  | {
      status: "resolved";
      policy: ActionPeriodPolicy;
      scope: ActionPeriodScope;
      serviceDeadlineMs: number | null;
    }
  | { status: "not_enabled" }
  | { status: "unavailable" };

/** The free floor's one period count, shared by every counted kind. */
export const FREE_TIER_PERIOD_SCOPE = {
  type: "pooled",
  poolKey: "free",
} as const satisfies ActionPeriodScope;

type AccessBudgetLimit =
  | {
      status: "limited";
      limit: number | undefined;
      scope: ActionPeriodScope;
      serviceDeadlineMs: number | null;
    }
  | { status: "not_enabled" }
  | { status: "unavailable" };

const accessBudgetLimit = ({
  access,
  evaluationActions,
  selfManagedActions,
}: ResolveOrganizationActionBudgetOptions): AccessBudgetLimit => {
  switch (access.type) {
    case "paid":
      return {
        status: "limited",
        limit: access.serviceActionsPerPeriod,
        scope: PER_KIND_PERIOD_SCOPE,
        serviceDeadlineMs: access.deadline.getTime(),
      };
    case "evaluation":
      return {
        status: "limited",
        limit: evaluationActions,
        scope: PER_KIND_PERIOD_SCOPE,
        serviceDeadlineMs: access.endsAt.getTime(),
      };
    // The free floor never expires; it ends only when the organization
    // regains paid access. Its budget is one count across every kind.
    case "free":
      return {
        status: "limited",
        limit: access.serviceActionsPerPeriod,
        scope: FREE_TIER_PERIOD_SCOPE,
        serviceDeadlineMs: null,
      };
    case "self_managed_keys":
      return {
        status: "limited",
        limit: selfManagedActions,
        scope: PER_KIND_PERIOD_SCOPE,
        serviceDeadlineMs: null,
      };
    case "ended":
      return { status: "not_enabled" };
    case "unavailable":
      return { status: "unavailable" };
    default:
      access satisfies never;
      return panic("Unhandled organization access");
  }
};

export const resolveOrganizationActionBudget = (
  options: ResolveOrganizationActionBudgetOptions,
): OrganizationActionBudget => {
  const resolved = accessBudgetLimit(options);
  switch (resolved.status) {
    case "not_enabled":
    case "unavailable":
      return { status: resolved.status };
    case "limited":
      break;
    default:
      resolved satisfies never;
      return panic("Unhandled organization budget limit");
  }
  const { periodMs } = options;
  const { limit, scope, serviceDeadlineMs } = resolved;
  if (
    periodMs === undefined ||
    !Number.isSafeInteger(periodMs) ||
    periodMs <= 0 ||
    limit === undefined ||
    !Number.isSafeInteger(limit) ||
    limit <= 0
  ) {
    return { status: "unavailable" };
  }
  return {
    status: "resolved",
    policy: { periodMs, limit },
    scope,
    serviceDeadlineMs,
  };
};

/**
 * A stored AI config means every model dispatch runs on the organization's
 * own key: role and by-id model resolution never fall back to the managed
 * provider for an organization with a config, and an undecryptable config
 * refuses the work rather than serving it managed.
 */
const readOrganizationModelCredentials = async (
  tx: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
): Promise<OrganizationModelCredentials> => {
  const row = await tx
    .select({ organizationId: organizationSettings.organizationId })
    .from(organizationSettings)
    .where(
      and(
        eq(organizationSettings.organizationId, organizationId),
        isNotNull(organizationSettings.aiConfigEncrypted),
      ),
    )
    .limit(1)
    .then((rows) => rows.at(0));
  return row === undefined
    ? ORGANIZATION_MODEL_CREDENTIALS.managed
    : ORGANIZATION_MODEL_CREDENTIALS.organization;
};

export const readOrganizationActionState = async (
  scopedDb: ScopedDb,
  organizationId: SafeId<"organization">,
): Promise<OrganizationActionState> =>
  await scopedDb(async (tx) => ({
    snapshot: await readOrganizationAccessSnapshot(tx, organizationId),
    freeTier: await readFreeTier(tx),
    modelCredentials: await readOrganizationModelCredentials(
      tx,
      organizationId,
    ),
  }));
