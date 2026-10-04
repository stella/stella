import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { ElysiaCustomStatusResponse } from "elysia/error";

import type { Transaction } from "@/api/db/root";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import {
  getContentDeliveryReceiptError,
  markContentDeliveryIntent,
  recordContentDeliveryReceipt,
  runWithContentDeliveryScope,
} from "@/api/lib/files/content-delivery";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const DELIVERY_ERROR = "Could not complete content delivery.";

describe("content delivery scopes", () => {
  test("a nested receipt cannot satisfy the surrounding delivery", async () => {
    await runWithContentDeliveryScope({ type: "audited" }, async () => {
      markContentDeliveryIntent();
      await runWithContentDeliveryScope({ type: "audited" }, async () => {
        markContentDeliveryIntent();
        recordContentDeliveryReceipt();
        expect(getContentDeliveryReceiptError()).toBeUndefined();
      });
      expect(getContentDeliveryReceiptError()).toMatchObject({
        message: DELIVERY_ERROR,
      });
    });
  });

  test("concurrent requests keep receipts in their originating scope", async () => {
    const complete = Promise.withResolvers<undefined>();
    const results = await Promise.all([
      runWithContentDeliveryScope({ type: "audited" }, async () => {
        markContentDeliveryIntent();
        await complete.promise;
        expect(getContentDeliveryReceiptError()).toMatchObject({
          message: DELIVERY_ERROR,
        });
        return "missing";
      }),
      runWithContentDeliveryScope({ type: "audited" }, async () => {
        markContentDeliveryIntent();
        recordContentDeliveryReceipt();
        complete.resolve(undefined);
        expect(getContentDeliveryReceiptError()).toBeUndefined();
        return "recorded";
      }),
    ]);
    expect(results).toEqual(["missing", "recorded"]);
  });
});

const BODY_CASES = [
  { name: "bytes", body: () => new Uint8Array([65, 66]) },
  {
    name: "stream",
    body: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([65, 66]));
          controller.close();
        },
      }),
  },
] as const;

const RAW_DELIVERY_CASES = [
  {
    name: "raw response",
    payload: () => new Response("AB"),
    headers: () => ({}),
  },
  {
    name: "array buffer",
    payload: () => new Uint8Array([65, 66]).buffer,
    headers: () => ({}),
  },
  {
    name: "typed array",
    payload: () => new Uint8Array([65, 66]),
    headers: () => ({}),
  },
  {
    name: "data view",
    payload: () => new DataView(new Uint8Array([65, 66]).buffer),
    headers: () => ({}),
  },
  { name: "buffer", payload: () => Buffer.from("AB"), headers: () => ({}) },
  { name: "blob", payload: () => new Blob(["AB"]), headers: () => ({}) },
  { name: "raw stream", payload: BODY_CASES[1].body, headers: () => ({}) },
  {
    name: "disposition record",
    payload: () => "AB",
    headers: () => ({
      "content-disposition": "attachment; filename=fixture.txt",
    }),
  },
  {
    name: "disposition headers",
    payload: () => "AB",
    headers: () =>
      new Headers({
        "Content-Disposition": "attachment; filename=fixture.txt",
      }),
  },
] as const;

describe("handler content delivery", () => {
  test.each(RAW_DELIVERY_CASES)(
    "$name requires a completed audit receipt at the response boundary",
    async ({ payload, headers }) => {
      const analytics = installRecordingAnalytics();
      const logger = installRecordingLogger();
      try {
        for (const audit of ["completed", "absent"] as const) {
          let inserted = 0;
          const value = payload();
          const recorder = createAuditRecorder({
            organizationId: toSafeId<"organization">("fixture-org"),
            userId: toSafeId<"user">("fixture-user"),
            workspaceId: null,
            request: new Request("https://example.test/delivery"),
            server: null,
          });
          const tx = asTestRaw<Transaction>({
            insert: () => ({
              values: async () => {
                inserted += 1;
              },
            }),
          });
          const endpoint = createSafePublicHandler(
            {
              accountAccess: ACCOUNT_ACCESS.sandbox,
              cache: { kind: "none" },
              mcp: { type: "internal", reason: "health_infra" },
              contentDelivery: { type: "audited" },
            },
            async function* () {
              if (audit === "completed") {
                yield* Result.await(
                  Result.tryPromise(async () => {
                    await recorder(tx, {
                      action: AUDIT_ACTION.DOWNLOAD,
                      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
                      resourceId: "fixture-entity",
                    });
                  }),
                );
              }
              return Result.ok(value);
            },
          );
          const response = await endpoint.handler(
            asTestRaw({
              request: new Request("https://example.test/delivery"),
              route: "/delivery",
              set: { headers: headers() },
            }),
          );
          expect(inserted).toBe(audit === "completed" ? 1 : 0);
          if (audit === "completed") {
            expect(response).toBe(value);
            continue;
          }
          expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
          if (response instanceof ElysiaCustomStatusResponse) {
            expect(response.code).toBe(500);
            expect(response.response).toEqual({ message: DELIVERY_ERROR });
          }
        }
      } finally {
        logger.restore();
        analytics.restore();
      }
    },
  );

  test.each(BODY_CASES)(
    "$name is withheld when the awaited audit insert fails",
    async ({ body }) => {
      const analytics = installRecordingAnalytics();
      const logger = installRecordingLogger();
      try {
        for (const insertResult of ["success", "failure"] as const) {
          let delivered = false;
          const recorder = createAuditRecorder({
            organizationId: toSafeId<"organization">("fixture-org"),
            userId: toSafeId<"user">("fixture-user"),
            workspaceId: null,
            request: new Request("https://example.test/delivery"),
            server: null,
          });
          const tx = asTestRaw<Transaction>({
            insert: () => ({
              values: async () => {
                if (insertResult === "failure") {
                  throw new Error("fixture audit insert unavailable");
                }
              },
            }),
          });
          const endpoint = createSafePublicHandler(
            {
              accountAccess: ACCOUNT_ACCESS.sandbox,
              cache: { kind: "none" },
              mcp: { type: "internal", reason: "health_infra" },
              contentDelivery: { type: "audited" },
            },
            async function* () {
              yield* Result.await(
                Result.tryPromise(async () => {
                  await recorder(tx, {
                    action: AUDIT_ACTION.DOWNLOAD,
                    resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
                    resourceId: "fixture-entity",
                  });
                }),
              );
              delivered = true;
              return Result.ok(
                secureDocumentResponse({
                  body: body(),
                  contentType: "application/octet-stream",
                  disposition: "attachment",
                  fileName: sanitizeFilename("fixture.bin"),
                }),
              );
            },
          );
          const response = await endpoint.handler(
            asTestRaw({
              request: new Request("https://example.test/delivery"),
              route: "/delivery",
              set: { headers: {} },
            }),
          );
          expect(delivered).toBe(insertResult === "success");
          if (insertResult === "success") {
            expect(response).toBeInstanceOf(Response);
            if (response instanceof Response) {
              expect(await response.text()).toBe("AB");
            }
            continue;
          }
          expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
          if (response instanceof ElysiaCustomStatusResponse) {
            expect(response.code).toBe(500);
          }
        }
      } finally {
        logger.restore();
        analytics.restore();
      }
    },
  );

  test.each(BODY_CASES)(
    "$name is returned only with a completed receipt",
    async ({ body }) => {
      const analytics = installRecordingAnalytics();
      const logger = installRecordingLogger();
      try {
        for (const receipt of ["recorded", "missing"] as const) {
          const endpoint = createSafePublicHandler(
            {
              accountAccess: ACCOUNT_ACCESS.sandbox,
              cache: { kind: "none" },
              mcp: { type: "internal", reason: "health_infra" },
              contentDelivery: { type: "audited" },
            },
            async function* () {
              if (receipt === "recorded") {
                recordContentDeliveryReceipt();
              }
              return Result.ok(
                secureDocumentResponse({
                  body: body(),
                  contentType: "application/octet-stream",
                  disposition: "attachment",
                  fileName: sanitizeFilename("fixture.bin"),
                }),
              );
            },
          );
          const response = await endpoint.handler(
            asTestRaw({
              request: new Request("https://example.test/delivery"),
              route: "/delivery",
              set: { headers: {} },
            }),
          );
          if (receipt === "recorded") {
            expect(response).toBeInstanceOf(Response);
            if (response instanceof Response) {
              expect(await response.text()).toBe("AB");
            }
            continue;
          }
          expect(response).toBeInstanceOf(ElysiaCustomStatusResponse);
          if (response instanceof ElysiaCustomStatusResponse) {
            expect(response.code).toBe(500);
            expect(response.response).toEqual({ message: DELIVERY_ERROR });
          }
        }
      } finally {
        logger.restore();
        analytics.restore();
      }
    },
  );
});
