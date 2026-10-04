import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import {
  getContentDeliveryReceiptError,
  markContentDeliveryIntent,
  runWithContentDeliveryScope,
} from "@/api/lib/files/content-delivery";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const DELIVERY_ERROR = "Could not complete content delivery.";

describe("signed content delivery", () => {
  test.each([
    { fileName: undefined, action: AUDIT_ACTION.ACCESS },
    { fileName: "fixture.pdf", action: AUDIT_ACTION.DOWNLOAD },
  ])("a completed $action row permits a URL", async ({ fileName, action }) => {
    const events: (AuditEvent | AuditEvent[])[] = [];
    const url = await runWithContentDeliveryScope(
      { type: "audited" },
      async () => {
        const result = await auditedPresignDownload({
          tx: asTestRaw<Transaction>({}),
          recordAuditEvent: async (_tx, event) => {
            events.push(event);
          },
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: "fixture-entity",
          s3Key: "fixture-key",
          expiresInSeconds: 60,
          ...(fileName === undefined ? {} : { fileName }),
          signDownload: async () => {
            markContentDeliveryIntent();
            return "https://example.test/fixture";
          },
        });
        expect(getContentDeliveryReceiptError()).toBeUndefined();
        return result;
      },
    );
    expect(url).toBe("https://example.test/fixture");
    expect(events).toHaveLength(1);
    expect(events.at(0)).toMatchObject({
      action,
      resourceId: "fixture-entity",
    });
  });

  test("a failed audit writes no receipt and issues no signed URL", async () => {
    const failure = new Error("fixture audit unavailable");
    let signingCalls = 0;
    await runWithContentDeliveryScope({ type: "audited" }, async () => {
      markContentDeliveryIntent();
      const result = await auditedPresignDownload({
        tx: asTestRaw<Transaction>({}),
        recordAuditEvent: async () => await Promise.reject(failure),
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: "fixture-entity",
        s3Key: "fixture-key",
        expiresInSeconds: 60,
        signDownload: async () => {
          signingCalls += 1;
          return "https://example.test/fixture";
        },
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(result).toBe(failure);
      expect(getContentDeliveryReceiptError()).toMatchObject({
        message: DELIVERY_ERROR,
      });
    });
    expect(signingCalls).toBe(0);
  });

  test("a pending audit produces a receipt only after its awaited insert succeeds", async () => {
    const insert = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    let signingCalls = 0;
    await runWithContentDeliveryScope({ type: "audited" }, async () => {
      markContentDeliveryIntent();
      const delivery = auditedPresignDownload({
        tx: asTestRaw<Transaction>({}),
        recordAuditEvent: async () => {
          started.resolve(undefined);
          await insert.promise;
        },
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: "fixture-entity",
        s3Key: "fixture-key",
        expiresInSeconds: 60,
        signDownload: async () => {
          signingCalls += 1;
          return "https://example.test/fixture";
        },
      });
      await started.promise;
      expect(signingCalls).toBe(0);
      expect(getContentDeliveryReceiptError()).toMatchObject({
        message: DELIVERY_ERROR,
      });
      insert.resolve(undefined);
      expect(await delivery).toBe("https://example.test/fixture");
      expect(getContentDeliveryReceiptError()).toBeUndefined();
      expect(signingCalls).toBe(1);
    });
  });
});
