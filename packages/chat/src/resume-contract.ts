import type { Interrupt } from "@ag-ui/core";
import { InterruptSchema } from "@ag-ui/core/schemas";
import * as v from "valibot";

/** Keep native interrupt validation tied to the protocol's owning schema. */
export const chatResumeSnapshotSchema = v.object({
  resumeState: v.object({ threadId: v.string(), runId: v.string() }),
  pendingInterrupts: v.optional(
    v.array(
      v.custom<Interrupt>((value) => InterruptSchema.safeParse(value).success),
    ),
  ),
});

/** Server truth for reconnecting readers; no local pointer establishes ownership. */
export const chatTurnResumeProbeSchema = v.variant("type", [
  v.object({ type: v.literal("preparing"), turnId: v.string() }),
  v.object({
    type: v.literal("running"),
    turnId: v.string(),
    runId: v.string(),
  }),
  v.object({
    type: v.literal("transcript"),
    turnId: v.string(),
    resumeSnapshot: v.optional(chatResumeSnapshotSchema),
  }),
]);
export type ChatTurnResumeProbe = v.InferOutput<
  typeof chatTurnResumeProbeSchema
>;
