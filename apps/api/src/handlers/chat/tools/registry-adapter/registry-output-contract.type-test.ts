import { expectTypeOf } from "bun:test";

import type {
  AllHandlerOutputsTyped,
  HandlerOutputsMatchByName,
} from "@/api/mcp/tool-types";

import type {
  ChatProjectableToolName,
  ProjectionDataByName,
  READ_TOOL_REF_FIELD_MAP,
  WRITE_TOOL_REF_FIELD_MAP,
} from "./ref-field-map";
import type {
  REGISTRY_READ_TOOL_HANDLERS,
  ThirdPartyOutboundReadToolName,
} from "./run-registry-tool";
import type { REGISTRY_WRITE_TOOL_HANDLERS } from "./run-registry-write-tool";

type ProjectableReadToolName = ChatProjectableToolName<
  typeof READ_TOOL_REF_FIELD_MAP
>;
type ProjectableWriteToolName = ChatProjectableToolName<
  typeof WRITE_TOOL_REF_FIELD_MAP
>;

expectTypeOf<
  "search_boe_legislation" | "lookup_business_registry"
>().toExtend<ThirdPartyOutboundReadToolName>();

expectTypeOf<
  AllHandlerOutputsTyped<
    typeof REGISTRY_READ_TOOL_HANDLERS,
    ProjectableReadToolName
  >
>().toEqualTypeOf<true>();
expectTypeOf<
  HandlerOutputsMatchByName<
    typeof REGISTRY_READ_TOOL_HANDLERS,
    ProjectionDataByName<
      typeof READ_TOOL_REF_FIELD_MAP,
      ProjectableReadToolName
    >,
    ProjectableReadToolName
  >
>().toEqualTypeOf<true>();

expectTypeOf<
  AllHandlerOutputsTyped<
    typeof REGISTRY_WRITE_TOOL_HANDLERS,
    ProjectableWriteToolName
  >
>().toEqualTypeOf<true>();
expectTypeOf<
  HandlerOutputsMatchByName<
    typeof REGISTRY_WRITE_TOOL_HANDLERS,
    ProjectionDataByName<
      typeof WRITE_TOOL_REF_FIELD_MAP,
      ProjectableWriteToolName
    >,
    ProjectableWriteToolName
  >
>().toEqualTypeOf<true>();
