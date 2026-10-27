import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { resolveSavedPdfSignTarget } from "@/components/inspector/pdf-signing.logic";
import type { api } from "@/lib/api";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(import.meta.env, { VITE_API_URL: "http://localhost:3001" });
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => Response.json(null), {
  preconnect: () => undefined,
});
const { uploadEntityVersion } = await import("./upload-entity-version");
const { hasActiveUpload } = await import("./active-uploads");
const { toSafeId } = await import("@/lib/safe-id");
const { createPdfSigningHandoff, readSavedPdfSignTarget } =
  await import("@/components/inspector/pdf-signing");

const WORKSPACE_ID = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000001",
);
const ENTITY_ID = toSafeId<"entity">("00000000-0000-4000-8000-000000000002");
const SAVED_VERSION_ID = toSafeId<"entityVersion">(
  "00000000-0000-4000-8000-000000000003",
);
const UPLOAD_ID = toSafeId<"pendingUpload">(
  "00000000-0000-4000-8000-000000000004",
);
const UPLOAD_PATH = `/v1/uploads/${WORKSPACE_ID}`;
const ENTITY_PATH = `/v1/entities/${WORKSPACE_ID}/entity/${ENTITY_ID}`;
const COMPETING_VERSION_ID = toSafeId<"entityVersion">(
  "00000000-0000-4000-8000-000000000006",
);
const SAVED_FIELD_ID = toSafeId<"field">(
  "00000000-0000-4000-8000-000000000007",
);
const COMPETING_FIELD_ID = toSafeId<"field">(
  "00000000-0000-4000-8000-000000000008",
);
const PROPERTY_ID = toSafeId<"property">(
  "00000000-0000-4000-8000-000000000009",
);

type UploadEndpoint = ReturnType<ReturnType<typeof api.uploads>>;
type FinalizedUploadResult = NonNullable<
  Awaited<ReturnType<UploadEndpoint["finalize"]["post"]>>["data"]
>["finalizedResult"];

afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(async () => await unregisterDomEnvironment());

test("a signing handoff targets the saved PDF even when another version becomes current", async () => {
  const pdf = PDF.create();
  pdf.addPage({ width: 200, height: 300 });
  const savedBytes = new Uint8Array(await pdf.save());
  const file = new File([savedBytes], "saved.pdf", { type: "application/pdf" });
  let currentVersionId = SAVED_VERSION_ID;
  const field = (id: typeof SAVED_FIELD_ID) =>
    ({
      id,
      propertyId: PROPERTY_ID,
      content: {
        type: "file",
        mimeType: "application/pdf",
      },
    }) satisfies Parameters<
      typeof resolveSavedPdfSignTarget
    >[0]["fields"][number];
  const requests: { method: string; path: string }[] = [];
  const handoffs: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      requests.push({ method: request.method, path: pathname });
      if (pathname === `${UPLOAD_PATH}/presign`) {
        return Response.json({
          uploadId: UPLOAD_ID,
          url: "https://storage.example.test/saved-pdf",
          headers: { "Content-Type": "application/pdf" },
        });
      }
      if (pathname === "/saved-pdf") {
        expect(request.method).toBe("PUT");
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(savedBytes);
        return new Response(null, { status: 200 });
      }
      if (pathname === `${UPLOAD_PATH}/${UPLOAD_ID}/finalize`) {
        currentVersionId = COMPETING_VERSION_ID;
        return Response.json({
          finalizedResult: {
            type: "entity_version",
            entityId: ENTITY_ID,
            entityVersionId: SAVED_VERSION_ID,
            versionNumber: 2,
            fileId: "00000000-0000-4000-8000-000000000005",
            fileName: "saved.pdf",
          } satisfies FinalizedUploadResult,
        });
      }
      if (pathname === `${ENTITY_PATH}/versions/${SAVED_VERSION_ID}`) {
        return Response.json({
          id: SAVED_VERSION_ID,
          versionNumber: 2,
          stamp: null,
          createdAt: "2026-10-01T12:00:00.000Z",
          fields: [field(SAVED_FIELD_ID)],
        });
      }
      if (pathname === ENTITY_PATH) {
        return Response.json({
          currentVersionId,
          fields: [field(COMPETING_FIELD_ID)],
        });
      }
      if (pathname === `/v1/entities/${WORKSPACE_ID}/pdf-signing-handoffs`) {
        handoffs.push(await request.json());
        return Response.json({
          deepLinkUrl: "stella://pdf-signing/fixture",
          expiresAt: "2026-10-01T12:02:00.000Z",
          sessionId: "00000000-0000-4000-8000-000000000010",
        });
      }
      return panic("Unexpected version-upload request", pathname);
    },
    { preconnect: () => undefined },
  );
  const result = await uploadEntityVersion({
    workspaceId: WORKSPACE_ID,
    entityId: ENTITY_ID,
    file,
  });
  expect(result).toEqual({
    type: "uploaded",
    entityVersionId: SAVED_VERSION_ID,
  });
  expect(currentVersionId).toBe(COMPETING_VERSION_ID);
  if (result.type !== "uploaded") {
    panic("The saved PDF upload was unexpectedly cancelled");
  }
  const savedTarget = await readSavedPdfSignTarget({
    entityVersionId: result.entityVersionId,
    target: {
      entityId: ENTITY_ID,
      fieldId: "00000000-0000-4000-8000-000000000011",
      propertyId: PROPERTY_ID,
      workspaceId: WORKSPACE_ID,
    },
  });
  if (savedTarget === null) {
    panic("The saved PDF has no signing target");
  }
  expect(savedTarget.fieldId).toBe(SAVED_FIELD_ID);
  await createPdfSigningHandoff(savedTarget);
  expect(handoffs).toEqual([
    {
      entityId: ENTITY_ID,
      fieldId: SAVED_FIELD_ID,
      propertyId: PROPERTY_ID,
    },
  ]);
  expect(requests).toEqual([
    { method: "POST", path: `${UPLOAD_PATH}/presign` },
    { method: "PUT", path: "/saved-pdf" },
    { method: "POST", path: `${UPLOAD_PATH}/${UPLOAD_ID}/finalize` },
    { method: "GET", path: `${ENTITY_PATH}/versions/${SAVED_VERSION_ID}` },
    {
      method: "POST",
      path: `/v1/entities/${WORKSPACE_ID}/pdf-signing-handoffs`,
    },
  ]);
  expect(hasActiveUpload()).toBe(false);
});
