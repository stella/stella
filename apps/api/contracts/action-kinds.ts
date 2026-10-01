import type {
  ActionKindDefinition,
  AdmittedActionIdentity,
} from "@/api/lib/rate-limit/action-kinds";

({ consumesServices: true }) satisfies ActionKindDefinition;
({ consumesServices: false }) satisfies ActionKindDefinition;

// @ts-expect-error every admission kind must declare whether it consumes services
({}) satisfies ActionKindDefinition;

({
  actionKind: "chat.improve-prompt",
  logicalPhaseId: "phase",
}) satisfies AdmittedActionIdentity;

({
  // @ts-expect-error unregistered action kinds cannot enter admission
  actionKind: "unknown.action",
  logicalPhaseId: "phase",
}) satisfies AdmittedActionIdentity;
