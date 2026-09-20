import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import type { McpRequestContext } from "@/api/mcp/context";
import { handlePrepareFileComparisonTool } from "@/api/mcp/file-comparison-prepare-tool";
import type { PrepareFileComparisonDependencies } from "@/api/mcp/file-comparison-prepare-tool";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const ORGANIZATION_ID = "org_1";
const BASE_SHA =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET_SHA =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type InsertedRow = {
  declaredSha256: string;
  declaredSize: number;
  id: string;
  kind: string;
  organizationId: string;
  userId: string;
};

type AuditEvent = { metadata?: Record<string, unknown>; workspaceId?: unknown };

const createHarness = ({
  memberRole = "owner",
}: { memberRole?: string } = {}) => {
  const inserted: InsertedRow[][] = [];
  const audited: AuditEvent[] = [];
  const presignedKeys: string[] = [];

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
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
  });

  const dependencies: PrepareFileComparisonDependencies = {
    presignUploadUrl: async ({ key, contentType, sha256Base64 }) => {
      presignedKeys.push(key);
      return await Promise.resolve(
        Result.ok({
          url: `https://s3.example/${key}`,
          headers: {
            "content-type": contentType,
            "content-length": "1",
            "x-amz-checksum-sha256": sha256Base64,
            "x-amz-sdk-checksum-algorithm": "SHA256" as const,
          },
        }),
      );
    },
  };

  return {
    audited,
    inserted,
    presignedKeys,
    run: async (args: Record<string, unknown>) =>
      await handlePrepareFileComparisonTool({ args, context }, dependencies),
  };
};

const validArgs = (overrides: Record<string, unknown> = {}) => ({
  base: { name: "Draft.docx", size: 2048, sha256_hex: BASE_SHA },
  target: { name: "Revised.docx", size: 4096, sha256_hex: TARGET_SHA },
  ...overrides,
});

type PrepareResult = Awaited<
  ReturnType<typeof handlePrepareFileComparisonTool>
>;

const dataOf = (result: PrepareResult) => {
  if ("egress" in result || result.status !== "success") {
    throw new Error(`Expected success, got ${JSON.stringify(result)}`);
  }
  return result.data;
};

const errorOf = (result: PrepareResult) => {
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

describe("prepare_file_comparison", () => {
  test("reserves two rows and echoes the compare_documents call back", async () => {
    const harness = createHarness();

    const data = dataOf(await harness.run(validArgs()));

    expect(harness.inserted.at(0)).toHaveLength(2);
    expect(harness.inserted.at(0)?.map(({ kind }) => kind)).toEqual([
      "input",
      "input",
    ]);
    // The echoed source is the exact object compare_documents accepts.
    expect(data.next).toEqual({
      tool: "compare_documents",
      source: {
        type: "uploads",
        base_upload_id: data.base.uploadId,
        target_upload_id: data.target.uploadId,
      },
    });
    expect(data.base.uploadId).not.toBe(data.target.uploadId);
    expect(data.base.headers["content-type"]).toBe(DOCX_MIME_TYPE);
    expect(harness.presignedKeys).toEqual([
      `${ORGANIZATION_ID}/tmp/comparisons/${data.base.uploadId}`,
      `${ORGANIZATION_ID}/tmp/comparisons/${data.target.uploadId}`,
    ]);
  });

  test("audits the reservation with sizes and no file names", async () => {
    const harness = createHarness();

    await harness.run(validArgs());

    const event = harness.audited.at(0);
    expect(event?.workspaceId).toBeNull();
    expect(event?.metadata).toMatchObject({
      baseSizeBytes: 2048,
      targetSizeBytes: 4096,
    });
    expect(JSON.stringify(event)).not.toContain("Draft.docx");
  });

  test("reads an uppercase checksum rather than rejecting its spelling", async () => {
    const harness = createHarness();

    const data = dataOf(
      await harness.run(
        validArgs({
          base: {
            name: "Draft.docx",
            size: 2048,
            sha256_hex: BASE_SHA.toUpperCase(),
          },
        }),
      ),
    );

    expect(data.base.headers["x-amz-checksum-sha256"]).toBe(
      Buffer.from(BASE_SHA, "hex").toString("base64"),
    );
  });

  test("refuses a size past the document limit, naming the field", async () => {
    const harness = createHarness();

    const error = errorOf(
      await harness.run(
        validArgs({
          base: {
            name: "Draft.docx",
            size: FILE_SIZE_LIMIT_BYTES.document + 1,
            sha256_hex: BASE_SHA,
          },
        }),
      ),
    );

    expect(error.code).toBe("validation_error");
    expect(error.issues?.map(({ path }) => path)).toContain("base.size");
    expect(harness.inserted).toHaveLength(0);
  });

  test("refuses a value that is no SHA-256 at all", async () => {
    const harness = createHarness();

    const error = errorOf(
      await harness.run(
        validArgs({
          base: { name: "Draft.docx", size: 2048, sha256_hex: "not-a-digest" },
        }),
      ),
    );

    expect(error.code).toBe("validation_error");
    expect(error.issues?.map(({ path }) => path)).toContain("base.sha256_hex");
    expect(harness.inserted).toHaveLength(0);
  });

  test("refuses a role that cannot update documents", async () => {
    const harness = createHarness({ memberRole: "external" });

    const error = errorOf(await harness.run(validArgs()));

    expect(error.code).toBe("permission_denied");
    expect(harness.inserted).toHaveLength(0);
  });
});
