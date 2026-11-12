import { LEGAL_GRAPH_EDGE_BACKFILL } from "../legal-graph-edge-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-legal-graph-edge-backfill",
  revision: 1450,
  type: "repairs",
  values: [LEGAL_GRAPH_EDGE_BACKFILL],
} satisfies OnlineMigrationEntry;
