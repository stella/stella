import type { HandlerConfig } from "@/api/lib/api-handlers";
import type {
  ActionKindDefinition,
  AdmittedActionIdentity,
  ConcurrencyOnlyActionKind,
} from "@/api/lib/rate-limit/action-kinds";

({
  consumesServices: true,
  admission: "period",
  serviceCredentials: "organization_model",
}) satisfies ActionKindDefinition;
({
  consumesServices: false,
  admission: "period",
  serviceCredentials: "managed_service",
}) satisfies ActionKindDefinition;

// Missing-property diagnostics land on the `satisfies` line, so the directive sits directly above it.
({
  admission: "period",
  serviceCredentials: "organization_model",
  // @ts-expect-error every admission kind must declare whether it consumes services
}) satisfies ActionKindDefinition;

({
  consumesServices: true,
  admission: "period",
  // @ts-expect-error every admission kind must declare whose credentials serve it
}) satisfies ActionKindDefinition;

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

({
  type: "handler",
  // @ts-expect-error finite handlers cannot declare a concurrency-only background kind
  actionKind: "workflow.background",
}) satisfies NonNullable<HandlerConfig["actionAdmission"]>;
