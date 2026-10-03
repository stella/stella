import { expect, test } from "bun:test";

import { createAdmissionRedis } from "@/api/lib/admission-redis";
import {
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";

for (const policy of ["noeviction", "allkeys-lru", "unknown"]) {
  test(`admission policy ${policy} emits its operator diagnostics and bounded metric`, async () => {
    const messages: string[] = [];
    const lines: string[] = [];
    setLogSinkForTesting((record) => messages.push(JSON.stringify(record)));
    setMetricLineSinkForTesting((line) => lines.push(line));
    const store = createAdmissionRedis({
      ready: async () => ({
        send: async () =>
          policy === "unknown"
            ? "# Memory\r\n"
            : `maxmemory_policy:${policy}\r\n`,
      }),
      close: () => {},
    });
    try {
      await store.ready();
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines.at(0) ?? "")).toMatchObject({
        _aws: {
          CloudWatchMetrics: [
            {
              Namespace: "Stella/Api",
              Dimensions: [[]],
              Metrics: [
                { Name: "AdmissionStoreEvictionPolicyRefused", Unit: "Count" },
              ],
            },
          ],
        },
        AdmissionStoreEvictionPolicyRefused: policy === "allkeys-lru" ? 1 : 0,
      });
      if (policy === "noeviction") {
        expect(messages).toEqual([]);
      } else {
        expect(messages).toHaveLength(1);
        expect(messages.at(0)).toContain(
          policy === "unknown"
            ? "eviction_policy_unknown"
            : "eviction_policy_refused",
        );
        expect(messages.at(0)).toContain("maxmemory-policy noeviction");
        expect(messages.at(0)).toContain(
          policy === "unknown"
            ? '"severityText":"WARN"'
            : '"severityText":"ERROR"',
        );
      }
    } finally {
      store.close();
      resetLogSinkForTesting();
      resetMetricLineSinkForTesting();
    }
  });
}
