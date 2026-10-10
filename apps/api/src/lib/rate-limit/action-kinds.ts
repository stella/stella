import type { ActionPeriodIdentity } from "@/api/lib/rate-limit/action-period-budget";

export type ActionKindDefinition = {
  consumesServices: boolean;
  admission: "period" | "concurrency-only";
};

export const ACTION_KINDS = {
  "billing.activity-drafts": { consumesServices: true, admission: "period" },
  "chat.send": { consumesServices: true, admission: "period" },
  "chat.generate-thread-title": { consumesServices: true, admission: "period" },
  "chat.improve-prompt": { consumesServices: true, admission: "period" },
  "chat.suggest-thread-title": { consumesServices: true, admission: "period" },
  "workflow.start": { consumesServices: true, admission: "period" },
  "flow.start": { consumesServices: true, admission: "period" },
  "workflow.background": {
    consumesServices: true,
    admission: "concurrency-only",
  },
  "flow.background": { consumesServices: true, admission: "concurrency-only" },
  "mcp.services/call": { consumesServices: true, admission: "period" },
  "mcp.data/call": { consumesServices: false, admission: "period" },
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
