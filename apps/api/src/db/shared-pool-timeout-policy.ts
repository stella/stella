import { panic } from "better-result";

import { DAY_IN_MS } from "@stll/time";

const MAX_MARGIN_MS = 10_000;
const MILLISECONDS_PER_SECOND = 1000;

export type SharedPoolTimeoutPolicy = {
  idleTimeoutMs: number;
  marginMs: number | null;
  capMs: number | null;
  requestedStatementTimeoutMs: number;
  effectiveStatementTimeoutMs: number | null;
  clamped: boolean;
};

type SharedPoolTimeoutOptions = {
  idleTimeoutSeconds: number;
  requestedStatementTimeoutMs: number;
};

export const resolveSharedPoolTimeoutPolicy = ({
  idleTimeoutSeconds,
  requestedStatementTimeoutMs,
}: SharedPoolTimeoutOptions): SharedPoolTimeoutPolicy => {
  const idleTimeoutMs = idleTimeoutSeconds * MILLISECONDS_PER_SECOND;
  if (
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs < 0 ||
    !Number.isSafeInteger(requestedStatementTimeoutMs) ||
    requestedStatementTimeoutMs < 0
  ) {
    panic("Shared database pool timeouts must be nonnegative safe integers");
  }

  if (idleTimeoutMs === 0) {
    return {
      idleTimeoutMs,
      marginMs: null,
      capMs: null,
      requestedStatementTimeoutMs,
      effectiveStatementTimeoutMs:
        requestedStatementTimeoutMs > 0 ? requestedStatementTimeoutMs : null,
      clamped: false,
    };
  }

  const marginMs = Math.min(MAX_MARGIN_MS, Math.floor(idleTimeoutMs / 2));
  const capMs = idleTimeoutMs - marginMs;
  const effectiveStatementTimeoutMs =
    requestedStatementTimeoutMs > 0
      ? Math.min(requestedStatementTimeoutMs, capMs)
      : capMs;
  return {
    idleTimeoutMs,
    marginMs,
    capMs,
    requestedStatementTimeoutMs,
    effectiveStatementTimeoutMs,
    clamped:
      requestedStatementTimeoutMs > 0 && requestedStatementTimeoutMs > capMs,
  };
};

export const clampSharedPoolTimeout = (
  requestedMs: number,
  policy: SharedPoolTimeoutPolicy,
): number => {
  if (!Number.isSafeInteger(requestedMs) || requestedMs <= 0) {
    panic("Shared database timeout override must be a positive safe integer");
  }
  return policy.idleTimeoutMs === 0 ||
    policy.effectiveStatementTimeoutMs === null
    ? requestedMs
    : Math.min(requestedMs, policy.effectiveStatementTimeoutMs);
};

export const parsePostgresTimeoutMs = (value: string): number => {
  const match = /^(\d+)(ms|s|min|h|d)?$/u.exec(value);
  if (match === null) {
    panic("PostgreSQL returned an unsupported timeout unit");
  }
  const multiplier = (() => {
    switch (match[2] ?? "ms") {
      case "ms":
        return 1;
      case "s":
        return 1000;
      case "min":
        return 60_000;
      case "h":
        return 3_600_000;
      case "d":
        return DAY_IN_MS;
      default:
        return panic("PostgreSQL returned an unsupported timeout unit");
    }
  })();
  const milliseconds = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(milliseconds)) {
    panic("PostgreSQL returned an unrepresentable timeout");
  }
  return milliseconds;
};
