import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createReadFileContentEndpoint } from "@/api/handlers/files/read-content";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

import { fileContentScalingScenario } from "./file-content";
import { readScalingViolations } from "./measurement";

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "granted file content scaling",
  () => {
    test("keeps a granted file read bounded as the matter's files grow", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      const storage = startFakeS3();
      try {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const small = await fileContentScalingScenario.measure({
            size: 10,
            db: openClient().db,
            storage,
            createEndpoint: createReadFileContentEndpoint,
          });
          const large = await fileContentScalingScenario.measure({
            size: 200,
            db: openClient().db,
            storage,
            createEndpoint: createReadFileContentEndpoint,
          });
          console.info(
            "handler-scaling",
            JSON.stringify({
              name: fileContentScalingScenario.name,
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
      } finally {
        storage.stop();
      }
    });
  },
);
