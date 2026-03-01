import type { ActorOptions, AnyActorRegistry } from "@rivetkit/framework-base";

import type { BBoxActorEvent } from "./actors/b-box-actor-config";
import type { SyncActorEvent } from "./actors/sync-actor-config";
import type { WorkflowActorEvent } from "./actors/workflow-actor-config";

export type CommonOptions = Pick<
  ActorOptions<AnyActorRegistry, "">,
  "createInRegion" | "createWithInput" | "params"
>;

export type VanillaOptions = [string[], CommonOptions];

export type OptionsType = "vanilla" | "react";

export type ActorEvent = SyncActorEvent | BBoxActorEvent | WorkflowActorEvent;
