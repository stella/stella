import { logger } from "../lib/observability/logger";
import { sharedPoolTimeoutPolicy } from "./shared-pool-timeouts";

type SharedPoolName = "root" | "raw_rls" | "public_law";

export const sharedPoolConnectionSettings = (pool: SharedPoolName) => {
  const policy = sharedPoolTimeoutPolicy;
  logger.info("database.shared_pool_timeout_configured", {
    pool,
    idleTimeoutMs: policy.idleTimeoutMs,
    requestedStatementTimeoutMs: policy.requestedStatementTimeoutMs,
    effectiveStatementTimeoutMs:
      policy.effectiveStatementTimeoutMs ?? "server_default",
    capMs: policy.capMs ?? 0,
    marginMs: policy.marginMs ?? 0,
    clamped: policy.clamped,
  });
  return policy.effectiveStatementTimeoutMs === null
    ? {}
    : { connection: { statement_timeout: policy.effectiveStatementTimeoutMs } };
};
