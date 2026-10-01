import type {
  ActionKindDefinition,
  AdmittedActionIdentity,
  ConcurrencyOnlyActionKind,
} from "@/api/lib/rate-limit/action-kinds";

({
  consumesServices: true,
  admission: "period",
}) satisfies ActionKindDefinition;
({
  consumesServices: false,
  admission: "period",
}) satisfies ActionKindDefinition;

// @ts-expect-error every admission kind must declare whether it consumes services
({ admission: "period" }) satisfies ActionKindDefinition;

({
  actionKind: "chat.improve-prompt",
  logicalPhaseId: "phase",
}) satisfies AdmittedActionIdentity;

({
  // @ts-expect-error unregistered action kinds cannot enter admission
  actionKind: "unknown.action",
  logicalPhaseId: "phase",
}) satisfies AdmittedActionIdentity;

// @ts-expect-error every registered kind must choose its admission mode
({ consumesServices: true }) satisfies ActionKindDefinition;

({
  // @ts-expect-error background kinds cannot reserve a period action
  actionKind: "workflow.background",
  logicalPhaseId: "phase",
}) satisfies AdmittedActionIdentity;

"workflow.background" satisfies ConcurrencyOnlyActionKind;
"flow.background" satisfies ConcurrencyOnlyActionKind;

// @ts-expect-error kickoff kinds cannot use background admission
"workflow.start" satisfies ConcurrencyOnlyActionKind;
// @ts-expect-error unregistered kinds cannot use background admission
"unknown.action" satisfies ConcurrencyOnlyActionKind;
