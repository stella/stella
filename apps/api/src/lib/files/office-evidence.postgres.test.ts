import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { officeFileEvidence } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { OBJECT_READ_TIMEOUT_MS } from "@/api/lib/s3";
import { XLSX_MIME_TYPE } from "@/api/mime-types";
import { activeFileContextFixture } from "@/api/tests/helpers/active-file-context";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import {
  responseByteFile,
  responseByteStream,
} from "@/api/tests/helpers/response-byte-stream";

import { loadOfficeEvidence } from "./office-evidence";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("Office evidence storage boundaries", () => {
  const fixture = activeFileContextFixture({
    fileName: "schedule.xlsx",
    mimeType: XLSX_MIME_TYPE,
  });
  beforeAll(fixture.seed);
  afterAll(fixture.dispose);
  const evidence = () =>
    rootDb
      .select()
      .from(officeFileEvidence)
      .where(eq(officeFileEvidence.fieldId, fixture.source.fieldId));
  const clearEvidence = async () => {
    await rootDb
      .delete(officeFileEvidence)
      .where(eq(officeFileEvidence.fieldId, fixture.source.fieldId));
  };

  test.each([
    "oversized",
    "undeclared",
    "read-deadline",
    "admission-deadline",
  ] as const)(
    "a %s read is reported and abandons the claim instead of caching empty evidence",
    async (kind) => {
      const byteLength =
        kind === "oversized" || kind === "undeclared"
          ? FILE_SIZE_LIMIT_BYTES.document + 1
          : 1;
      using bodyFile = responseByteFile(byteLength);
      const store = startFakeS3({
        readResponse: ({ headers }) => {
          const responseHeaders = new Headers(headers);
          if (kind === "undeclared") {
            responseHeaders.delete("content-length");
          } else {
            responseHeaders.set("content-length", String(byteLength));
          }
          return new Response(
            kind === "undeclared"
              ? responseByteStream(byteLength).body
              : bodyFile.body,
            { headers: responseHeaders },
          );
        },
      });
      store.put(
        envBase.S3_BUCKET,
        fixture.key,
        new Uint8Array(1),
        XLSX_MIME_TYPE,
      );
      const analytics = installRecordingAnalytics();
      const deadline = new AbortController();
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(
        (milliseconds) =>
          milliseconds === OBJECT_READ_TIMEOUT_MS
            ? deadline.signal
            : originalTimeout(milliseconds),
      );
      const timers = spyOn(globalThis, "setTimeout");
      const hold =
        kind === "read-deadline" || kind === "admission-deadline"
          ? store.holdNext({ method: "GET", keyIncludes: fixture.key })
          : null;
      const loading = loadOfficeEvidence(fixture);
      try {
        if (hold !== null) {
          await hold.reached;
          expect(timeoutSpy.mock.calls).toContainEqual([
            OBJECT_READ_TIMEOUT_MS,
          ]);
          if (kind === "read-deadline") {
            deadline.abort();
          } else {
            const fireDeadline = timers.mock.calls
              .find(
                ([, delay]) => delay === LIMITS.workPoolHeavySidecarDeadlineMs,
              )
              ?.at(0);
            if (typeof fireDeadline !== "function") {
              panic("Office evidence did not acquire its admission deadline");
            }
            fireDeadline();
          }
          hold.release();
        }
        expect(await loading).toBeNull();
        expect(await evidence()).toEqual([]);
        expect(
          analytics.exceptions().map(({ properties }) => properties),
        ).toMatchObject([{ operation: "office-evidence-file-read" }]);
        if (kind === "oversized") {
          expect(analytics.exceptions().at(0)?.properties["error.class"]).toBe(
            "S3ObjectBudgetError",
          );
        }
        expect(store.requests.map(({ method }) => method)).toEqual(["GET"]);
      } finally {
        deadline.abort();
        hold?.release();
        try {
          await loading;
        } finally {
          timers.mockRestore();
          timeoutSpy.mockRestore();
          analytics.restore();
          store.stop();
          await clearEvidence();
        }
      }
    },
  );

  test("a supported spreadsheet yields encrypted evidence and reuses its current claim", async () => {
    const bytes = new Uint8Array(
      await Bun.file(
        new URL("../search/__fixtures__/schedule.xlsx", import.meta.url),
      ).arrayBuffer(),
    );
    const store = startFakeS3();
    store.put(envBase.S3_BUCKET, fixture.key, bytes, XLSX_MIME_TYPE);
    const analytics = installRecordingAnalytics();
    try {
      const first = await loadOfficeEvidence(fixture);
      expect(first?.format).toBe("xlsx");
      expect(first?.blocks.map(({ text }) => text).join("\n")).toContain(
        "Acme s.r.o.",
      );
      expect(await loadOfficeEvidence(fixture)).toEqual(first);
      const rows = await evidence();
      expect(rows).toHaveLength(1);
      expect(rows.at(0)).toMatchObject({
        status: "available",
        claimToken: null,
        claimExpiresAt: null,
        errorCode: null,
      });
      expect(rows.at(0)?.payloadCiphertext).toBeInstanceOf(Buffer);
      expect(store.requests.map(({ method }) => method)).toEqual(["GET"]);
      expect(analytics.exceptions()).toEqual([]);
    } finally {
      analytics.restore();
      store.stop();
      await clearEvidence();
    }
  });
});
