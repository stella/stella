import type { ActionPeriodIdentity } from "@/api/lib/rate-limit/action-period-budget";

export type ActionKindDefinition = { consumesServices: boolean };

export const ACTION_KINDS = {
  "chat.send": { consumesServices: true },
  "chat.generate-thread-title": { consumesServices: true },
  "chat.improve-prompt": { consumesServices: true },
  "chat.suggest-thread-title": { consumesServices: true },
  "mcp.services/call": { consumesServices: true },
  "mcp.data/call": { consumesServices: false },
} as const satisfies Record<string, ActionKindDefinition>;

export type ActionKind = keyof typeof ACTION_KINDS;

export type AdmittedActionIdentity = Omit<
  ActionPeriodIdentity,
  "actionKind"
> & {
  actionKind: ActionKind;
};
