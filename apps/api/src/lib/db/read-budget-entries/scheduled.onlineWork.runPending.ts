import { ONLINE_WORK_NAMES } from "../../../db/online-migrations";
import type { ReadBudget } from "../read-budget-definition";

export default {
  surface: "scheduled-job",
  pages: 2 * (4 * ONLINE_WORK_NAMES.length + 8),
  reason:
    "At most two registry-filtered state snapshots per tick: three primary-key index pages plus one heap page per registered unit, and eight catalog pages per snapshot for the table-owner policy. The registry is in memory and the advisory lock reads no relation pages. Build catalog probes run in the detached unit under the online-work database pressure governor, outside the scheduler tick.",
} as const satisfies ReadBudget;
