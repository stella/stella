import { expectTypeOf } from "expect-type";

import type { McpExposure } from "@/api/lib/api-handlers";

type CapabilityExposure = Extract<McpExposure, { type: "capability" }>;

expectTypeOf<CapabilityExposure["consumesServices"]>().toEqualTypeOf<boolean>();
expectTypeOf<{
  type: "capability";
  reason: "workflow_orchestration";
}>().not.toExtend<CapabilityExposure>();
expectTypeOf<{
  type: "capability";
  reason: "workflow_orchestration";
  consumesServices: false;
}>().toExtend<CapabilityExposure>();
