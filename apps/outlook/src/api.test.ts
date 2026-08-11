import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { DOCUMENT_UPLOAD_POLICY } from "@stll/api-contract";
import { toSafeId } from "@stll/api/types";

import {
  APIError,
  putPresignedEmail,
  shouldRetainPendingEmailUpload,
} from "@/api";

const directUpload = {
  eml: new File(["message"], "message.eml", { type: "message/rfc822" }),
  headers: { "content-type": "message/rfc822" },
  uploadId: toSafeId<"pendingUpload">("upload-1"),
  url: "https://objects.example.test/upload-1",
  workspaceId: toSafeId<"workspace">("workspace-1"),
} satisfies Parameters<typeof putPresignedEmail>[0];

test("upload timeout covers a maximum-size email at the supported slow rate", () => {
  const minimumTransferMs = Math.ceil(
    (DOCUMENT_UPLOAD_POLICY.maxBytes /
      DOCUMENT_UPLOAD_POLICY.minimumBytesPerSecond) *
      1000,
  );

  expect(DOCUMENT_UPLOAD_POLICY.putTimeoutMs).toBeGreaterThanOrEqual(
    minimumTransferMs,
  );
});

describe("direct email upload reservation", () => {
  test("aborts the reservation after an HTTP PUT failure", async () => {
    const abortReservation = mock(async () => undefined);

    const result = await Result.tryPromise({
      try: async () =>
        await putPresignedEmail(directUpload, {
          abortReservation,
          put: mock(async () => new Response(null, { status: 503 })),
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 503 });
    }
    expect(abortReservation).toHaveBeenCalledTimes(1);
  });

  test("aborts the reservation after a transport failure", async () => {
    const abortReservation = mock(async () => undefined);

    const result = await Result.tryPromise({
      try: async () =>
        await putPresignedEmail(directUpload, {
          abortReservation,
          put: mock(async () => {
            throw new DOMException("timeout");
          }),
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 502 });
    }
    expect(abortReservation).toHaveBeenCalledTimes(1);
  });

  test("keeps a successful reservation for finalize", async () => {
    const abortReservation = mock(async () => undefined);

    await putPresignedEmail(directUpload, {
      abortReservation,
      put: mock(async () => new Response(null, { status: 200 })),
    });

    expect(abortReservation).not.toHaveBeenCalled();
  });
});

describe("pending email finalize retry", () => {
  test("retains the upload after uncertain and retryable failures", () => {
    expect(shouldRetainPendingEmailUpload(new DOMException("timeout"))).toBe(
      true,
    );
    expect(
      shouldRetainPendingEmailUpload(
        new APIError({ message: "in progress", status: 409 }),
      ),
    ).toBe(true);
    expect(
      shouldRetainPendingEmailUpload(
        new APIError({ message: "temporary", status: 500 }),
      ),
    ).toBe(true);
    for (const status of [502, 503, 504]) {
      expect(
        shouldRetainPendingEmailUpload(
          new APIError({ message: "gateway response", status }),
        ),
      ).toBe(true);
    }
  });

  test("releases the upload after a terminal finalize response", () => {
    expect(
      shouldRetainPendingEmailUpload(
        new APIError({ message: "missing", status: 404 }),
      ),
    ).toBe(false);
    expect(
      shouldRetainPendingEmailUpload(
        new APIError({ message: "rejected", status: 422 }),
      ),
    ).toBe(false);
  });
});
