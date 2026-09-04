import { describe, expect, test } from "bun:test";

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

    expect(operation).rejects.toThrow("S3 rejected upload (503)");
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

    expect(operation).rejects.toThrow("network unavailable");
    await operation.catch(() => undefined);
    expect(events).toEqual(["put", "abort"]);
  });
});
