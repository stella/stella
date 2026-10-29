import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import {
  fingerprintHttpRequest,
  fingerprintRequest,
  runWithRequestReceipt,
} from "./request-receipts";

const request = {
  method: "POST",
  route: "/matters/:workspaceId/tasks",
  params: { workspaceId: "matter" },
  query: { mode: "create" },
};

test("request fingerprints canonicalize nested JSON order and wire values", () => {
  expect(
    fingerprintRequest({
      ...request,
      body: { name: "Případ", nested: { b: 2, a: [1, null] } },
    }),
  ).toBe(
    fingerprintRequest({
      ...request,
      body: { nested: { a: [1, null], b: 2 }, name: "Případ" },
    }),
  );
  expect(
    fingerprintRequest({
      ...request,
      body: { date: new Date("2026-01-01T00:00:00Z"), omitted: undefined },
    }),
  ).toBe(
    fingerprintRequest({
      ...request,
      body: { date: "2026-01-01T00:00:00.000Z" },
    }),
  );
});

test("request fingerprints bind method, route, params, query and typed JSON values", () => {
  const original = { ...request, body: { value: 1, order: [1, 2] } };
  const fingerprint = fingerprintRequest(original);
  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  for (const different of [
    { ...original, method: "PUT" },
    { ...original, route: "/other" },
    { ...original, params: { workspaceId: "other" } },
    { ...original, query: { mode: "other" } },
    { ...original, body: { value: "1", order: [1, 2] } },
    { ...original, body: { value: 1, order: [2, 1] } },
  ]) {
    expect(fingerprintRequest(different)).not.toBe(fingerprint);
  }
});

test("HTTP fingerprints bind nested file contents and transmitted metadata", async () => {
  const body = (file: File) => ({
    attachments: [{ file }],
    date: new Date("2026-01-01T00:00:00Z"),
  });
  const file = new File(["first"], "brief.txt", {
    type: "text/plain",
    lastModified: 1,
  });
  const same = new File(["first"], "brief.txt", {
    type: "text/plain",
    lastModified: 2,
  });
  const different = new File(["other"], "brief.txt", {
    type: "text/plain",
    lastModified: 1,
  });
  expect(file.size).toBe(different.size);
  const original = await fingerprintHttpRequest({
    ...request,
    body: body(file),
  });
  expect(await fingerprintHttpRequest({ ...request, body: body(same) })).toBe(
    original,
  );
  expect(
    await fingerprintHttpRequest({ ...request, body: body(different) }),
  ).not.toBe(original);
  expect(
    await fingerprintHttpRequest({
      ...request,
      body: body(new File(["first"], "other.txt", { type: "text/plain" })),
    }),
  ).not.toBe(original);
  expect(
    await fingerprintHttpRequest({
      ...request,
      body: body(new File(["first"], "brief.txt", { type: "text/html" })),
    }),
  ).not.toBe(original);
});

test("HTTP fingerprint normalization preserves JSON dates and binds blob bytes", async () => {
  const json = {
    ...request,
    body: { date: new Date("2026-01-01T00:00:00Z"), omitted: undefined },
  };
  expect(await fingerprintHttpRequest(json)).toBe(fingerprintRequest(json));
  const blobRequest = { ...request, body: { attachment: new Blob(["first"]) } };
  expect(await fingerprintHttpRequest(blobRequest)).toBe(
    await fingerprintHttpRequest({
      ...request,
      body: { attachment: new Blob(["first"]) },
    }),
  );
  expect(await fingerprintHttpRequest(blobRequest)).not.toBe(
    await fingerprintHttpRequest({
      ...request,
      body: { attachment: new Blob(["other"]) },
    }),
  );
});

test("invalid idempotency keys return typed failures before claiming or creating", async () => {
  for (const key of ["", "x".repeat(129)]) {
    const result = await runWithRequestReceipt({
      scopedDb: async () => panic("Invalid keys must not reach the database"),
      organizationId: mintAuthProviderId<"organization">(),
      userId: mintAuthProviderId<"user">(),
      key,
      route: "/test/create",
      fingerprint: "a".repeat(64),
      run: async () => panic("Invalid keys must not execute the handler"),
      responseStatus: () => 201,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({ status: 400 });
    }
  }
});

test("request authorization refuses before accessing a stored receipt", async () => {
  const refusal = new HandlerError({
    status: 404,
    message: "Selected matters are unavailable",
  });
  const result = await runWithRequestReceipt({
    scopedDb: async () => panic("A refused request must not read its receipt"),
    organizationId: mintAuthProviderId<"organization">(),
    userId: mintAuthProviderId<"user">(),
    key: "retained-intent",
    route: "/test/create",
    fingerprint: "a".repeat(64),
    authorize: async () => Result.err(refusal),
    run: async () => panic("A refused request must not create a resource"),
    responseStatus: () => 201,
  });
  expect(result).toEqual(Result.err(refusal));
});
