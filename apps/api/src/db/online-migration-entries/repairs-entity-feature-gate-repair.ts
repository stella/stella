import { ENTITY_FEATURE_GATE_REPAIR } from "../entity-feature-gate-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-entity-feature-gate-repair",
  revision: 1170,
  type: "repairs",
  values: [ENTITY_FEATURE_GATE_REPAIR],
} satisfies OnlineMigrationEntry;
