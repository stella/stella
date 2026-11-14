import { describe, expect, test } from "bun:test";

import { createGetExactIconHandler } from "@/api/handlers/chat/link-icons/get-exact";
import { exactIconScalingScenario } from "@/api/tests/read-scaling/link-icons";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

describe.skipIf(process.env["STELLA_RUN_VALKEY_TESTS"] !== "true")(
  "exact icon cache scaling",
  () => {
    test("the production handler returns the same bounded cache hit at both cache populations", async () => {
      const small = await exactIconScalingScenario.measure(
        10,
        createGetExactIconHandler,
      );
      const large = await exactIconScalingScenario.measure(
        200,
        createGetExactIconHandler,
      );
      expect(small.redisRoundTrips).toBe(1);
      expect(large.redisRoundTrips).toBe(1);
      expect(small.statements).toBe(0);
      expect(large.statements).toBe(0);
      expect(small.transactionRoundTrips).toBe(0);
      expect(large.transactionRoundTrips).toBe(0);
      expect(small.rows).toBe(1);
      expect(large.rows).toBe(1);
      expect(readScalingViolations({ small, large })).toEqual([]);
    });
  },
);
