import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";

import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import { type MatterLearning, TALLY_STATUSES } from "./matter-learning";
import {
  ruleSchema,
  ruleShape,
  type StoreBinding,
  unavailableSchema,
  useStoredSection,
} from "./matter-store-section";

const learningSchema = v.strictObject({
  rules: v.array(ruleSchema),
  learned: v.array(
    v.strictObject({
      token: v.string(),
      matterId: v.string(),
      weight: v.number(),
      atMs: v.number(),
    }),
  ),
  tallies: v.array(
    v.strictObject({
      ...ruleShape,
      count: v.number(),
      status: v.picklist(TALLY_STATUSES),
    }),
  ),
});
const learningReadSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("stored"),
    revision: v.number(),
    learning: learningSchema,
  }),
  unavailableSchema,
]);
const LEARNING_BINDING: StoreBinding<MatterLearning> = {
  window: DESKTOP_TELEMETRY_WINDOWS.activity,
  read: async () => {
    const read = v.parse(
      learningReadSchema,
      await invoke("activity_get_matter_learning"),
    );
    return read.type === "stored"
      ? { type: "ready", revision: read.revision, value: read.learning }
      : { type: "unavailable" };
  },
  write: async (revision, learning) =>
    await invoke("activity_save_matter_learning", { revision, learning }),
};

/** The activity window's rules and learned weights. */
export const useMatterLearning = () => useStoredSection(LEARNING_BINDING);
