import type { ActionPeriodIdentity } from "@/api/lib/rate-limit/action-period-budget";

/**
 * Whose credentials serve a kind's work. `organization_model`: the work runs
 * on the organization's own model key whenever one is configured, and on the
 * managed provider otherwise (every model dispatch resolves this way).
 * `managed_service`: the work always runs on services the deployment hosts.
 */
export const ACTION_SERVICE_CREDENTIALS = {
  organizationModel: "organization_model",
  managedService: "managed_service",
} as const;

export type ActionServiceCredentials =
  (typeof ACTION_SERVICE_CREDENTIALS)[keyof typeof ACTION_SERVICE_CREDENTIALS];

export type ActionKindDefinition = {
  consumesServices: boolean;
  admission: "period" | "concurrency-only";
  serviceCredentials: ActionServiceCredentials;
};

const ORGANIZATION_MODEL = ACTION_SERVICE_CREDENTIALS.organizationModel;
const MANAGED_SERVICE = ACTION_SERVICE_CREDENTIALS.managedService;

export const ACTION_KINDS = {
  "chat.send": {
    consumesServices: true,
    admission: "period",
    serviceCredentials: ORGANIZATION_MODEL,
  },
  "chat.generate-thread-title": {
    consumesServices: true,
    admission: "period",
    serviceCredentials: ORGANIZATION_MODEL,
  },
  "chat.improve-prompt": {
    consumesServices: true,
    admission: "period",
    serviceCredentials: ORGANIZATION_MODEL,
  },
  "chat.suggest-thread-title": {
    consumesServices: true,
    admission: "period",
    serviceCredentials: ORGANIZATION_MODEL,
  },
  "workflow.start": {
    consumesServices: true,
    admission: "period",
    serviceCredentials: ORGANIZATION_MODEL,
  },
  "flow.start": {
    consumesServices: true,
    admission: "period",
    serviceCredentials: ORGANIZATION_MODEL,
  },
  "workflow.background": {
    consumesServices: true,
    admission: "concurrency-only",
    serviceCredentials: ORGANIZATION_MODEL,
  },
  "flow.background": {
    consumesServices: true,
    admission: "concurrency-only",
    serviceCredentials: ORGANIZATION_MODEL,
  },
  "mcp.services/call": {
    consumesServices: true,
    admission: "period",
    serviceCredentials: MANAGED_SERVICE,
  },
  "mcp.data/call": {
    consumesServices: false,
    admission: "period",
    serviceCredentials: MANAGED_SERVICE,
  },
} as const satisfies Record<string, ActionKindDefinition>;

export type ActionKind = keyof typeof ACTION_KINDS;

type RegisteredAction = {
  [Kind in ActionKind]: { actionKind: Kind } & (typeof ACTION_KINDS)[Kind];
}[ActionKind];

export type PeriodActionKind = Extract<
  RegisteredAction,
  { admission: "period" }
>["actionKind"];

export type ConcurrencyOnlyActionKind = Extract<
  RegisteredAction,
  { admission: "concurrency-only" }
>["actionKind"];

export const QUEUED_ACTION_KIND = {
  extraction: "workflow.start",
  flow: "flow.start",
} as const satisfies Record<string, PeriodActionKind>;

export const BACKGROUND_ACTION_KIND = {
  extraction: "workflow.background",
  flow: "flow.background",
} as const satisfies Record<string, ConcurrencyOnlyActionKind>;

export type AdmittedActionIdentity = Omit<
  ActionPeriodIdentity,
  "actionKind"
> & {
  actionKind: PeriodActionKind;
};
