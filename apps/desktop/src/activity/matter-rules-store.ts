import { invoke } from "@tauri-apps/api/core";
import * as v from "valibot";

import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import type { MatterRule } from "./matter-learning";
import {
  ruleSchema,
  type StoreBinding,
  unavailableSchema,
  useStoredSection,
} from "./matter-store-section";

const rulesReadSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("stored"),
    revision: v.number(),
    rules: v.array(ruleSchema),
  }),
  unavailableSchema,
]);
const RULES_BINDING: StoreBinding<MatterRule[]> = {
  window: DESKTOP_TELEMETRY_WINDOWS.main,
  read: async () => {
    const read = v.parse(
      rulesReadSchema,
      await invoke("activity_get_matter_rules"),
    );
    return read.type === "stored"
      ? { type: "ready", revision: read.revision, value: read.rules }
      : { type: "unavailable" };
  },
  write: async (revision, rules) =>
    await invoke("activity_save_matter_rules", { revision, rules }),
};

/** Settings' view of the rules alone, never the learned weights. */
export const useMatterRules = () => useStoredSection(RULES_BINDING);
