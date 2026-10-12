import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/node";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { toSafeId } from "@/api/lib/branded-types";
import { ENCRYPTED_CONTENT_MESSAGE } from "@/api/lib/files/detect-file-encryption";
import { SafeOutboundFetchError } from "@/api/lib/safe-outbound-fetch";
import type { McpRequestContext } from "@/api/mcp/context";
import { handlePrepareFileComparisonFromLinksTool } from "@/api/mcp/file-comparison-links-tool";
import type { PrepareFileComparisonFromLinksDependencies } from "@/api/mcp/file-comparison-links-tool";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { createEncryptedPdf } from "@/api/tests/helpers/signed-pdf";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const ORGANIZATION_ID = "org_1";

const BASE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
const TARGET_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x05, 0x06]);
/** Digests of the fixtures above, so the handler's hashing has an oracle. */
const BASE_SHA =
  "72ddd979de80b61ca55ce309f4c2a029c78a7ef9b6259e0a3d5e17a191a4cfdf";
const TARGET_SHA =
  "8a65744490a05cafca95aecd8a345372130cb2e41f4bc15eddc049f5de69f29f";

const BASE_URL = "https://files.example/share/Draft.docx";
const TARGET_URL = "https://files.example/share/Revised%20final.docx";

type InsertedRow = {
  declaredName: string;
  declaredSha256: string;
  declaredSize: number;
  id: string;
  kind: string;
};

type AuditEvent = { metadata?: Record<string, unknown>; workspaceId?: unknown };

type PutCall = { headers: Record<string, string>; size: number; url: string };

type DownloadResponse = Awaited<
  ReturnType<PrepareFileComparisonFromLinksDependencies["download"]>
>;

const okDownload = (bytes: Uint8Array): DownloadResponse =>
  Result.ok({
    body: new Uint8Array(bytes).buffer,
    headers: new Headers(),
    ok: true,
    status: 200,
  });

type HarnessOptions = {
  downloads?: Record<string, DownloadResponse>;
  memberRole?: string;
  putOk?: (url: string) => boolean;
};

const createHarness = ({
  downloads = {},
  memberRole = "owner",
  putOk = () => true,
}: HarnessOptions = {}) => {
  const inserted: InsertedRow[][] = [];
  const audited: AuditEvent[] = [];
  const puts: PutCall[] = [];
  let downloadCount = 0;

  const { safeDb, scopedDb } = createScopedDbMock({
    insert: () => ({
      values: async (rows: InsertedRow[]) => {
        inserted.push(rows);
        await Promise.resolve();
      },
    }),
  });

  const context = asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: [],
    accessibleWorkspaceIdSet: new Set<string>(),
    accessibleWorkspaceStatusById: new Map(),
    accessibleWorkspaces: [],
    grantedScopes: ["stella:documents_write"],
    memberRole,
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    recordAuditEvent: async (_tx: unknown, event: AuditEvent) => {
      audited.push(event);
      await Promise.resolve();
    },
    thirdPartyOutboundPermit: grantThirdPartyOutboundPermit(),
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
  });

  const dependencies: PrepareFileComparisonFromLinksDependencies = {
    download: async ({ url }) => {
      downloadCount += 1;
      return await Promise.resolve(
        downloads[String(url)] ??
          okDownload(String(url) === BASE_URL ? BASE_BYTES : TARGET_BYTES),
      );
    },
    presignUploadUrl: async ({ key, contentType, sha256Base64 }) =>
      await Promise.resolve(
        Result.ok({
          url: `https://s3.example/${key}`,
          headers: {
            "content-type": contentType,
            "content-length": "1",
            "x-amz-checksum-sha256": sha256Base64,
            "x-amz-sdk-checksum-algorithm": "SHA256" as const,
          },
        }),
      ),
    put: async ({ bytes, reservation }) => {
      puts.push({
        headers: reservation.headers,
        size: bytes.byteLength,
        url: reservation.url,
      });
      return await Promise.resolve(
        Result.ok(
          new Response(null, { status: putOk(reservation.url) ? 200 : 500 }),
        ),
      );
    },
  };

  return {
    audited,
    context,
    dependencies,
    get downloadCount() {
      return downloadCount;
    },
    inserted,
    puts,
    run: async (args: Record<string, unknown>) =>
      await handlePrepareFileComparisonFromLinksTool(
        { args, context },
        dependencies,
      ),
  };
};

const validArgs = (overrides: Record<string, unknown> = {}) => ({
  base: { url: BASE_URL, name: "Draft: v2.docx" },
  target: { url: TARGET_URL },
  ...overrides,
});

type LinksResult = Awaited<
  ReturnType<typeof handlePrepareFileComparisonFromLinksTool>
>;

const dataOf = (result: LinksResult) => {
  if ("egress" in result || result.status !== "success") {
    throw new Error(`Expected success, got ${JSON.stringify(result)}`);
  }
  return result.data;
};

const errorOf = (result: LinksResult) => {
  if (
    "egress" in result ||
    result.status !== "error" ||
    result.error.type !== "structured"
  ) {
    throw new Error(
      `Expected a structured error, got ${JSON.stringify(result)}`,
    );
  }
  return result.error;
};

describe("prepare_file_comparison_from_links", () => {
  test("does not fetch when the request context has no permit", async () => {
    const harness = createHarness();
    const result = await handlePrepareFileComparisonFromLinksTool(
      {
        args: validArgs(),
        context: { ...harness.context, thirdPartyOutboundPermit: undefined },
      },
      harness.dependencies,
    );

    expect(result).toMatchObject({
      status: "error",
      error: { type: "structured", code: "permission_denied" },
    });
    expect(harness.downloadCount).toBe(0);
  });

  test("stages both downloads and echoes the compare_documents call back", async () => {
    const harness = createHarness();

    const data = dataOf(await harness.run(validArgs()));

    const rows = harness.inserted.at(0);
    expect(rows).toHaveLength(2);
    expect(rows?.map(({ declaredSha256 }) => declaredSha256)).toEqual([
      BASE_SHA,
      TARGET_SHA,
    ]);
    expect(rows?.map(({ declaredSize }) => declaredSize)).toEqual([
      BASE_BYTES.byteLength,
      TARGET_BYTES.byteLength,
    ]);
    // The caller's name is sanitized; the unnamed side falls back to the
    // decoded last path segment of its link.
    expect(rows?.map(({ declaredName }) => declaredName)).toEqual([
      "Draft_ v2.docx",
      "Revised final.docx",
    ]);
    expect(data.next).toEqual({
      tool: "compare_documents",
      source: {
        type: "uploads",
        base_upload_id: data.base.uploadId,
        target_upload_id: data.target.uploadId,
      },
    });
    expect(data.base.name).toBe("Draft_ v2.docx");
    expect(data.target.size).toBe(TARGET_BYTES.byteLength);
    expect(harness.audited.at(0)?.metadata).toMatchObject({
      baseUploadId: data.base.uploadId,
      targetUploadId: data.target.uploadId,
    });
  });

  test("PUTs each file to its own slot with the presigned headers", async () => {
    const harness = createHarness();

    const data = dataOf(await harness.run(validArgs()));

    expect(harness.puts).toEqual([
      {
        headers: {
          "content-type": DOCX_MIME_TYPE,
          "content-length": "1",
          "x-amz-checksum-sha256": Buffer.from(BASE_SHA, "hex").toString(
            "base64",
          ),
          "x-amz-sdk-checksum-algorithm": "SHA256",
        },
        size: BASE_BYTES.byteLength,
        url: `https://s3.example/${ORGANIZATION_ID}/tmp/comparisons/${data.base.uploadId}`,
      },
      {
        headers: {
          "content-type": DOCX_MIME_TYPE,
          "content-length": "1",
          "x-amz-checksum-sha256": Buffer.from(TARGET_SHA, "hex").toString(
            "base64",
          ),
          "x-amz-sdk-checksum-algorithm": "SHA256",
        },
        size: TARGET_BYTES.byteLength,
        url: `https://s3.example/${ORGANIZATION_ID}/tmp/comparisons/${data.target.uploadId}`,
      },
    ]);
  });

  test("names the failing side when a link cannot be downloaded", async () => {
    const harness = createHarness({
      downloads: {
        [TARGET_URL]: Result.err(
          new SafeOutboundFetchError({ message: "Redirects are not allowed" }),
        ),
      },
    });

    const error = errorOf(await harness.run(validArgs()));

    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("The target file could not be downloaded");
    expect(error.issues?.at(0)?.path).toBe("target.url");
    expect(error.issues?.at(0)?.message).toBe("Redirects are not allowed");
    expect(harness.inserted).toHaveLength(0);
    expect(harness.puts).toHaveLength(0);
  });

  test("names the failing side when a link answers with an error status", async () => {
    const harness = createHarness({
      downloads: {
        [BASE_URL]: Result.ok({
          body: new ArrayBuffer(0),
          headers: new Headers(),
          ok: false,
          status: 403,
        }),
      },
    });

    const error = errorOf(await harness.run(validArgs()));

    expect(error.message).toBe("The base file could not be downloaded");
    expect(error.issues?.at(0)?.message).toContain("403");
    expect(harness.inserted).toHaveLength(0);
  });

  test("refuses bytes that are not a zip, so not a .docx", async () => {
    const harness = createHarness({
      downloads: {
        [BASE_URL]: okDownload(
          new TextEncoder().encode("<html>Sign in to view</html>"),
        ),
      },
    });

    const error = errorOf(await harness.run(validArgs()));

    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("The base file is not a .docx");
    expect(error.issues?.at(0)?.path).toBe("base.url");
    expect(harness.inserted).toHaveLength(0);
  });

  for (const format of ["docx", "xlsx", "pptx"] as const) {
    test(`refuses a password-protected ${format} as encrypted content`, async () => {
      const locked = new Uint8Array(
        await Bun.file(
          new URL(
            `../lib/files/__fixtures__/password-protected-${format}.cfb`,
            import.meta.url,
          ),
        ).arrayBuffer(),
      );
      const harness = createHarness({
        downloads: { [BASE_URL]: okDownload(locked) },
      });

      const error = errorOf(await harness.run(validArgs()));

      expect(error).toMatchObject({
        code: "validation_error",
        message: ENCRYPTED_CONTENT_MESSAGE,
        issues: [{ path: "base.url" }],
      });
      expect(harness.inserted).toHaveLength(0);
    });
  }

  test("refuses an encrypted PDF as not a .docx", async () => {
    const harness = createHarness({
      downloads: {
        [BASE_URL]: okDownload(new Uint8Array(await createEncryptedPdf())),
      },
    });

    const error = errorOf(await harness.run(validArgs()));

    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("The base file is not a .docx");
    expect(harness.inserted).toHaveLength(0);
  });

  test("refuses an empty body", async () => {
    const harness = createHarness({
      downloads: { [TARGET_URL]: okDownload(new Uint8Array(0)) },
    });

    const error = errorOf(await harness.run(validArgs()));

    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("The target file is empty");
    expect(harness.inserted).toHaveLength(0);
  });

  test("refuses a link that is not HTTPS", async () => {
    const harness = createHarness();

    const error = errorOf(
      await harness.run(
        validArgs({ base: { url: "http://files.example/Draft.docx" } }),
      ),
    );

    expect(error.code).toBe("validation_error");
    expect(error.issues?.map(({ path }) => path)).toContain("base.url");
    expect(harness.inserted).toHaveLength(0);
  });

  test("refuses a role that cannot update documents", async () => {
    const harness = createHarness({ memberRole: "external" });

    const error = errorOf(await harness.run(validArgs()));

    expect(error.code).toBe("permission_denied");
    expect(harness.inserted).toHaveLength(0);
    expect(harness.puts).toHaveLength(0);
  });

  test("reports a failed transfer as retryable and leaves the slots to expire", async () => {
    const harness = createHarness({
      putOk: (url) => !url.includes("comparisons"),
    });

    const error = errorOf(await harness.run(validArgs()));

    expect(error.code).toBe("internal_error");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(
      "The base file could not be transferred to stella storage",
    );
    expect(harness.inserted).toHaveLength(1);
  });
});

for (const text of ["", "abc", "Příliš žluťoučký kůň 📄 中文", "e\u0301"]) {
  test(`linked comparison reservations preserve exact downloaded SHA-256 bytes: ${JSON.stringify(text)}`, async () => {
    // A DOCX download must start with ZIP magic, even for an empty text payload.
    const bytes = new Uint8Array([
      ...BASE_BYTES,
      ...new TextEncoder().encode(text),
    ]);
    const harness = createHarness({
      downloads: {
        [BASE_URL]: okDownload(bytes),
        [TARGET_URL]: okDownload(bytes),
      },
    });
    dataOf(await harness.run(validArgs()));
    expect(
      harness.inserted.at(0)?.map(({ declaredSha256 }) => declaredSha256),
    ).toEqual([sha256Hex(bytes), sha256Hex(bytes)]);
  });
}
