import { expectTypeOf } from "expect-type";

import type { McpExposure } from "@/api/lib/api-handlers";
import type { ServiceClassification } from "@/api/lib/rate-limit/service-classification";

type CapabilityExposure = Extract<McpExposure, { type: "capability" }>;

expectTypeOf<
  CapabilityExposure["consumesServices"]
>().toEqualTypeOf<ServiceClassification>();
expectTypeOf<{
  type: "capability";
  reason: "workflow_orchestration";
}>().not.toExtend<CapabilityExposure>();
expectTypeOf<{
  type: "capability";
  reason: "workflow_orchestration";
  consumesServices: false;
}>().toExtend<CapabilityExposure>();
