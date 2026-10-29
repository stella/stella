import { expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";

import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import {
  createInvoiceLinkTokenAdmission,
  INVOICE_LINK_TOKEN_BUDGET,
} from "@/api/lib/rate-limit/invoice-link-admission";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

test("token attempts stay refused until the shared window expires, then admit again", async () => {
  let now = 1000;
  const context = new InMemoryRateLimitContext(() => now);
  const admission = createInvoiceLinkTokenAdmission(context);
  const hash = sha256Hex("invoice-link-cooldown-test");
  try {
    for (let attempt = 0; attempt < INVOICE_LINK_TOKEN_BUDGET.max; attempt++) {
      expect((await admission(hash)).isOk()).toBe(true);
    }
    expect((await admission(hash)).isErr()).toBe(true);
    now += INVOICE_LINK_TOKEN_BUDGET.duration - 1;
    expect((await admission(hash)).isErr()).toBe(true);
    now += 1;
    expect((await admission(hash)).isOk()).toBe(true);
    expect(context.read(`invoice-link-token:${hash}`)?.count).toBe(1);
  } finally {
    context.kill();
  }
});

test("the counter key and quota rejection telemetry expose only the token hash", async () => {
  const plaintext = "a".repeat(64);
  const hash = sha256Hex(plaintext);
  const keys: string[] = [];
  const durations: (number | undefined)[] = [];
  const logs = installRecordingLogger();
  const metrics: string[] = [];
  setMetricLineSinkForTesting((line) => {
    metrics.push(line);
  });
  const admission = createInvoiceLinkTokenAdmission({
    increment: (key, duration) => {
      keys.push(key);
      durations.push(duration);
      return {
        count: INVOICE_LINK_TOKEN_BUDGET.max + 1,
        nextReset: new Date(1000 + INVOICE_LINK_TOKEN_BUDGET.duration),
        start: 1000,
      };
    },
  });
  try {
    const rejected = await admission(hash);
    expect(rejected.isErr()).toBe(true);
    expect(keys).toEqual([`invoice-link-token:${hash}`]);
    expect(durations).toEqual([INVOICE_LINK_TOKEN_BUDGET.duration]);
    expect(logs.records).toHaveLength(1);
    expect(metrics).toHaveLength(1);
    for (const recorded of [keys, rejected, logs.records, metrics]) {
      expect(JSON.stringify(recorded)).not.toContain(plaintext);
    }
    expect(JSON.stringify(logs.records)).not.toContain(hash);
    expect(JSON.stringify(metrics)).not.toContain(hash);
  } finally {
    resetMetricLineSinkForTesting();
    logs.restore();
  }
});
