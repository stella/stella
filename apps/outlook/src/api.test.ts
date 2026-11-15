import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@stll/api-contract/safe-id";

import {
  type FileEmailDependencies,
  FileEmailError,
  fileEmailToMatter,
  FinalizePendingError,
  isRetryableFinalizeError,
  putPresignedEmail,
  sha256Hex,
} from "@/api";
import { OutlookAPIError } from "@/lib/outlook-api-error";

/** The outcome of `run`, keeping the thrown value itself as the error. */
const settle = async <T>(run: () => Promise<T>) =>
  await Result.tryPromise({ catch: (cause) => cause, try: run });

const WORKSPACE_ID = toSafeId<"workspace">("workspace-1");
const UPLOAD_ID = toSafeId<"pendingUpload">("upload-1");
const PROPERTY_ID = "property-file";

type Call = { body: unknown; method: string; path: string };

type Route = (call: Call) => unknown;

/**
 * A stand-in for the API client: answers each path from `routes` and runs
 * the real response parser, so the schemas are exercised too.
 */
const fakeApi = (routes: Record<string, Route>) => {
  const calls: Call[] = [];
  const request: FileEmailDependencies["request"] = async ({
    body,
    method = "GET",
    parse,
    path,
  }) => {
    const call = { body, method, path };
    calls.push(call);
    const route = Object.entries(routes).find(([suffix]) =>
      path.endsWith(suffix),
    )?.[1];
    if (!route) {
      throw new OutlookAPIError({ message: "Not found", status: 404 });
    }
    const parsed = parse(await Promise.resolve(route(call)));
    if (!parsed.success) {
      throw new OutlookAPIError({
        message: "Invalid API response",
        status: 502,
      });
    }
    return parsed.output;
  };
  return { calls, request };
};

const filingRoutes = (finalize: Route): Record<string, Route> => ({
  [`/properties/${WORKSPACE_ID}`]: () => [
    { content: { type: "text" }, id: "property-text" },
    { content: { type: "file" }, id: PROPERTY_ID },
  ],
  "/presign": () => ({
    expiresAt: "2026-11-10T12:00:00.000Z",
    headers: { "content-type": "message/rfc822", "x-amz-checksum-sha256": "x" },
    uploadId: UPLOAD_ID,
    url: "https://objects.example.test/tmp/upload-1",
  }),
  "/finalize": finalize,
  "/entity/entity-1": () => ({
    entityId: "entity-1",
    fields: [
      { id: "field-name", propertyId: "property-text" },
      { id: "field-file", propertyId: PROPERTY_ID },
    ],
  }),
  "/abort": () => ({ ok: true }),
});

const finalized = () => ({
  finalizedResult: {
    entityId: "entity-1",
    fileId: "file-1",
    fileName: "SPA review.eml",
    renamed: false,
    type: "entity_create",
  },
});

const eml = new File(["From: a@example.test\r\n\r\nHello"], "SPA review.eml", {
  type: "message/rfc822",
});

const okPut = () =>
  mock(
    async (_url: string, _init: RequestInit) =>
      await Promise.resolve(new Response(null, { status: 200 })),
  );
const noSleep = async () => {
  await Promise.resolve();
};

describe("filing an email", () => {
  test("presigns, uploads the exact bytes and finalizes into the file column", async () => {
    const api = fakeApi(filingRoutes(finalized));
    const put = okPut();

    const filed = await fileEmailToMatter(
      { eml, workspaceId: WORKSPACE_ID },
      { put, request: api.request, sleep: noSleep },
    );

    expect(filed).toEqual({
      entityId: toSafeId<"entity">("entity-1"),
      fieldId: toSafeId<"field">("field-file"),
      fileName: "SPA review.eml",
      workspaceId: WORKSPACE_ID,
    });
    const bytes = new Uint8Array(await eml.arrayBuffer());
    expect(api.calls.find((call) => call.path.endsWith("/presign"))).toEqual({
      body: {
        mimeType: "message/rfc822",
        name: "SPA review.eml",
        parentId: null,
        propertyId: PROPERTY_ID,
        purpose: "entity_create",
        sha256Hex: await sha256Hex(bytes),
        size: bytes.byteLength,
      },
      method: "POST",
      path: `/uploads/${WORKSPACE_ID}/presign`,
    });
    expect(put).toHaveBeenCalledTimes(1);
    const [url, init] = put.mock.calls.at(0) ?? [];
    expect(url).toBe("https://objects.example.test/tmp/upload-1");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual({
      "content-type": "message/rfc822",
      "x-amz-checksum-sha256": "x",
    });
    expect(
      api.calls.find((call) => call.path.endsWith("/finalize")),
    ).toMatchObject({
      body: undefined,
      method: "POST",
      path: `/uploads/${WORKSPACE_ID}/${UPLOAD_ID}/finalize`,
    });
    expect(api.calls.some((call) => call.path.endsWith("/abort"))).toBe(false);
  });

  test("hashes with lowercase hex SHA-256", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("refuses a matter without a file column before uploading", async () => {
    const api = fakeApi({
      [`/properties/${WORKSPACE_ID}`]: () => [
        { content: { type: "text" }, id: "property-text" },
      ],
    });
    const put = okPut();

    const result = await settle(
      async () =>
        await fileEmailToMatter(
          { eml, workspaceId: WORKSPACE_ID },
          { put, request: api.request, sleep: noSleep },
        ),
    );

    expect(Result.isError(result) && result.error).toBeInstanceOf(
      FileEmailError,
    );
    expect(put).not.toHaveBeenCalled();
  });

  test("retries a finalize that did not answer on the same upload", async () => {
    let attempts = 0;
    const api = fakeApi(
      filingRoutes(() => {
        attempts += 1;
        if (attempts < 3) {
          throw new OutlookAPIError({ message: "busy", status: 503 });
        }
        return finalized();
      }),
    );

    const filed = await fileEmailToMatter(
      { eml, workspaceId: WORKSPACE_ID },
      { put: okPut(), request: api.request, sleep: noSleep },
    );

    expect(filed.entityId).toBe(toSafeId<"entity">("entity-1"));
    expect(
      api.calls.filter((call) => call.path.endsWith("/presign")),
    ).toHaveLength(1);
    expect(attempts).toBe(3);
  });

  test("keeps the stored upload when finalize keeps failing", async () => {
    const api = fakeApi(
      filingRoutes(() => {
        throw new OutlookAPIError({ message: "in progress", status: 409 });
      }),
    );

    const result = await settle(
      async () =>
        await fileEmailToMatter(
          { eml, workspaceId: WORKSPACE_ID },
          { put: okPut(), request: api.request, sleep: noSleep },
        ),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(FinalizePendingError);
      if (result.error instanceof FinalizePendingError) {
        expect(result.error.pending).toEqual({
          propertyId: toSafeId<"property">(PROPERTY_ID),
          uploadId: UPLOAD_ID,
          workspaceId: WORKSPACE_ID,
        });
      }
    }
  });

  test("links the matter when the filed document cannot be read back", async () => {
    const routes = filingRoutes(finalized);
    delete routes["/entity/entity-1"];
    const api = fakeApi(routes);

    const filed = await fileEmailToMatter(
      { eml, workspaceId: WORKSPACE_ID },
      { put: okPut(), request: api.request, sleep: noSleep },
    );

    expect(filed.fieldId).toBeNull();
  });
});

describe("presigned PUT", () => {
  const upload = {
    bytes: new Uint8Array([1, 2, 3]),
    headers: { "content-type": "message/rfc822" },
    uploadId: UPLOAD_ID,
    url: "https://objects.example.test/tmp/upload-1",
    workspaceId: WORKSPACE_ID,
  };

  test("abandons the reservation after an HTTP failure", async () => {
    const api = fakeApi({ "/abort": () => ({ ok: true }) });

    const result = await settle(
      async () =>
        await putPresignedEmail(upload, {
          put: mock(async () => new Response(null, { status: 403 })),
          request: api.request,
        }),
    );

    expect(Result.isError(result) && result.error).toMatchObject({
      status: 403,
    });
    expect(api.calls).toEqual([
      {
        body: {},
        method: "POST",
        path: `/uploads/${WORKSPACE_ID}/${UPLOAD_ID}/abort`,
      },
    ]);
  });

  test("abandons the reservation after a transport failure, even when abort fails", async () => {
    const api = fakeApi({});

    const result = await settle(
      async () =>
        await putPresignedEmail(upload, {
          put: mock(async () => {
            throw new DOMException("timeout", "TimeoutError");
          }),
          request: api.request,
        }),
    );

    expect(Result.isError(result) && result.error).toMatchObject({
      status: 502,
    });
    expect(api.calls.map((call) => call.path)).toEqual([
      `/uploads/${WORKSPACE_ID}/${UPLOAD_ID}/abort`,
    ]);
  });
});

describe("finalize retry policy", () => {
  test("retries unanswered, busy and server failures", () => {
    expect(isRetryableFinalizeError(new DOMException("timeout"))).toBe(true);
    for (const status of [409, 500, 502, 503]) {
      expect(
        isRetryableFinalizeError(new OutlookAPIError({ message: "", status })),
      ).toBe(true);
    }
  });

  test("stops on a refusal", () => {
    for (const status of [400, 403, 404, 422]) {
      expect(
        isRetryableFinalizeError(new OutlookAPIError({ message: "", status })),
      ).toBe(false);
    }
  });
});
