import type { McpExposure } from "@/api/lib/api-handlers";

type CapabilityExposure = Extract<McpExposure, { type: "capability" }>;

const unclassifiedCapability = {
  type: "capability",
  reason: "workflow_orchestration",
} as const;

// @ts-expect-error every capability must declare a service classification
unclassifiedCapability satisfies CapabilityExposure;

({
  type: "capability",
  reason: "workflow_orchestration",
  consumesServices: false,
}) satisfies CapabilityExposure;

({
  type: "capability",
  reason: "workflow_orchestration",
  consumesServices: (input) => input.body !== null,
}) satisfies CapabilityExposure;
