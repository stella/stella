import { schedulerBackfillConfig } from "@/api/lib/scheduler/backfill-config";

export default schedulerBackfillConfig().batchStatementTimeoutMs;
