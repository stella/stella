import { describe, expect, test } from "bun:test";

import personalDataExportDownloadLink from "@/api/handlers/account-exports/download/get";

import { accountExportDownloadScalingScenario } from "./account-exports";
import { readScalingViolations } from "./measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "account export download link scaling",
  () => {
    test("keeps the owned download link bounded as export history grows", async () => {
      const small = await accountExportDownloadScalingScenario.measure({
        size: 10,
        handler: personalDataExportDownloadLink.handler,
      });
      const large = await accountExportDownloadScalingScenario.measure({
        size: 200,
        handler: personalDataExportDownloadLink.handler,
      });
      console.info(
        "handler-scaling",
        JSON.stringify({
          name: accountExportDownloadScalingScenario.name,
          at10: small,
          at200: large,
        }),
      );
      expect(small.rows).toBe(1);
      expect(large.rows).toBe(1);
      expect(small.statements).toBeGreaterThan(0);
      expect(small.transactionRoundTrips).toBeGreaterThan(0);
      expect(readScalingViolations({ small, large })).toEqual([]);
    });
  },
);
