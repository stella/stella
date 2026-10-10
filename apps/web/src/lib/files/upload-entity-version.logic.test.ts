import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { completeEntityVersionUpload } from "./upload-entity-version.logic";

describe("entity version upload completion", () => {
  test("finalizes only after storage accepts the file", async () => {
    const events: string[] = [];
    await completeEntityVersionUpload({
      abort: async () => {
        events.push("abort");
      },
      finalize: async () => {
        events.push("finalize");
      },
      put: async () => {
        events.push("put");
        return new Response(null, { status: 200 });
      },
    });

    expect(events).toEqual(["put", "finalize"]);
  });

  test("aborts a rejected storage upload and never finalizes", async () => {
    const events: string[] = [];
    const operation = completeEntityVersionUpload({
      abort: async () => {
        events.push("abort");
      },
      finalize: async () => {
        events.push("finalize");
      },
      put: async () => {
        events.push("put");
        return new Response(null, { status: 503 });
      },
    });

    expect(await rejectionOf(operation)).toHaveProperty(
      "message",
      expect.stringContaining("S3 rejected upload (503)"),
    );
    // swallow-ok: drains the upload after the named storage-rejection assertion above
    await operation.catch(() => undefined);
    expect(events).toEqual(["put", "abort"]);
  });

  test("aborts a failed storage request and preserves its error", async () => {
    const events: string[] = [];
    const operation = completeEntityVersionUpload({
      abort: async () => {
        events.push("abort");
      },
      finalize: async () => {
        events.push("finalize");
      },
      put: async () => {
        events.push("put");
        throw new TypeError("network unavailable");
      },
    });

    expect(await rejectionOf(operation)).toHaveProperty(
      "message",
      expect.stringContaining("network unavailable"),
    );
    // swallow-ok: drains the upload after the named network-error assertion above
    await operation.catch(() => undefined);
    expect(events).toEqual(["put", "abort"]);
  });
});
