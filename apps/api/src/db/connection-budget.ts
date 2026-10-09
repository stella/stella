import { panic } from "better-result";

import { LIMITS } from "@/api/lib/limits";

const DATABASE_POOL_DEFAULTS = {
  DATABASE_ROOT_POOL_MAX: 5,
  DATABASE_RLS_POOL_MAX: 5,
  PUBLIC_LAW_DATABASE_POOL_MAX: 2,
} as const;

type PoolConfiguration = Record<keyof typeof DATABASE_POOL_DEFAULTS, number>;
type ProcessAssumption = {
  maxReplicas: number;
  pools: PoolConfiguration;
  publicPool: "shared" | "separate";
};

// Reference envelope, including overlapping replacements. Validate the actual
// deployment and other clients before using this envelope to change capacity.
const DATABASE_PROCESS_ASSUMPTIONS = {
  api: {
    maxReplicas: 8,
    pools: { ...DATABASE_POOL_DEFAULTS, DATABASE_ROOT_POOL_MAX: 12 },
    publicPool: "shared",
  },
  documentWorker: {
    maxReplicas: 2,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  backgroundWorker: {
    maxReplicas: 6,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  utilityWorker: {
    maxReplicas: 0,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  operator: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  migrator: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  analysis: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  census: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  identityMap: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  authBackfill: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  signInReplay: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  authAudit: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  rehearsal: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
  seedReset: {
    maxReplicas: 1,
    pools: DATABASE_POOL_DEFAULTS,
    publicPool: "shared",
  },
} as const satisfies Record<string, ProcessAssumption>;

type ProcessName = keyof typeof DATABASE_PROCESS_ASSUMPTIONS;
const SHARED_POOL_PROCESSES = [
  "api",
  "documentWorker",
  "backgroundWorker",
  "utilityWorker",
  "operator",
] as const;

type PoolMaximum =
  | { type: "configured"; key: keyof PoolConfiguration }
  | { type: "fixed"; value: number };
type PoolDefinition = {
  file: string;
  constructor: number;
  maximum: PoolMaximum;
  processes: readonly ProcessName[];
  admission: "pooled" | "dedicated";
};

// Constructor ordinal is local to its file. The census compares both the
// constructor set and its actual maximum; additions require a budget decision.
const DATABASE_POOLS = [
  {
    file: "src/db/root.ts",
    constructor: 1,
    maximum: { type: "configured", key: "DATABASE_ROOT_POOL_MAX" },
    processes: SHARED_POOL_PROCESSES,
    admission: "pooled",
  },
  {
    file: "src/db/root.ts",
    constructor: 2,
    maximum: { type: "configured", key: "DATABASE_RLS_POOL_MAX" },
    processes: SHARED_POOL_PROCESSES,
    admission: "pooled",
  },
  {
    file: "src/lib/public-law-read-db.ts",
    constructor: 1,
    maximum: { type: "configured", key: "PUBLIC_LAW_DATABASE_POOL_MAX" },
    processes: SHARED_POOL_PROCESSES,
    admission: "pooled",
  },
  {
    file: "src/db/long-running-connection.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: SHARED_POOL_PROCESSES,
    admission: "dedicated",
  },
  {
    file: "src/lib/health/database-login-probe.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["api"],
    admission: "pooled",
  },
  {
    file: "src/db/migrate.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["migrator"],
    admission: "pooled",
  },
  {
    file: "src/db/online-index-observer.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["migrator"],
    admission: "pooled",
  },
  {
    file: "src/scripts/decision-analysis.db.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 4 },
    processes: ["analysis"],
    admission: "pooled",
  },
  {
    file: "src/scripts/database-census.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["census"],
    admission: "pooled",
  },
  {
    file: "src/scripts/better-auth-microsoft-identity-map.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["identityMap"],
    admission: "pooled",
  },
  {
    file: "src/scripts/better-auth-17-backfill.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["authBackfill"],
    admission: "pooled",
  },
  {
    file: "src/scripts/better-auth-sign-in-replay.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["signInReplay"],
    admission: "pooled",
  },
  {
    file: "src/scripts/better-auth-migration-audit.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["authAudit"],
    admission: "pooled",
  },
  {
    file: "src/scripts/seed-migration-rehearsal.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["rehearsal"],
    admission: "pooled",
  },
  {
    file: "scripts/seed-reset.ts",
    constructor: 1,
    maximum: { type: "fixed", value: 1 },
    processes: ["seedReset"],
    admission: "pooled",
  },
] as const satisfies readonly PoolDefinition[];

// These are required deployment bounds, not observed server settings. Live
// validation must confirm at least this capacity and at most these reservations.
const DATABASE_CONNECTION_BUDGET = {
  minimumMaxConnections: 750,
  reservedConnectionsCeiling: 16,
  otherClientsCeiling: 100,
  utilizationPercent: 70,
} as const;

const connectionBudgetForProcess = (
  process: ProcessName,
  configuration: ProcessAssumption = DATABASE_PROCESS_ASSUMPTIONS[process],
) => {
  let pooled = 0;
  let dedicated: "absent" | "present" = "absent";
  for (const pool of DATABASE_POOLS) {
    if (!pool.processes.some((name) => name === process)) {
      continue;
    }
    if (pool.admission === "dedicated") {
      dedicated = "present";
      continue;
    }
    switch (pool.maximum.type) {
      case "fixed":
        pooled += pool.maximum.value;
        break;
      case "configured":
        if (
          pool.maximum.key === "PUBLIC_LAW_DATABASE_POOL_MAX" &&
          configuration.publicPool === "shared"
        ) {
          continue;
        }
        pooled += configuration.pools[pool.maximum.key];
        break;
      default:
        pool.maximum satisfies never;
        return panic("Unknown database pool maximum");
    }
  }
  const perProcess =
    pooled +
    (dedicated === "present"
      ? LIMITS.databaseDedicatedConnectionsPerProcess
      : 0);
  return { perProcess, fleet: perProcess * configuration.maxReplicas };
};

export const DATABASE_CONNECTION_CONFIG = {
  defaults: DATABASE_POOL_DEFAULTS,
  processes: DATABASE_PROCESS_ASSUMPTIONS,
  pools: DATABASE_POOLS,
  budget: DATABASE_CONNECTION_BUDGET,
  forProcess: connectionBudgetForProcess,
} as const;
