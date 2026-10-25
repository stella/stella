import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { S3PresignError } from "@/api/lib/s3-presign";
import {
  FILE_COMPARISON_ORGANIZATION_OUTSTANDING_BYTE_LIMIT,
  FILE_COMPARISON_ORGANIZATION_OUTSTANDING_ROW_LIMIT,
  FILE_COMPARISON_OUTSTANDING_BYTE_LIMIT,
  FILE_COMPARISON_OUTSTANDING_ROW_LIMIT,
} from "@/api/lib/uploads/file-comparison/uploads";
import { handlePrepareFileComparisonTool } from "@/api/mcp/file-comparison-prepare-tool";
import type { PrepareFileComparisonDependencies } from "@/api/mcp/file-comparison-prepare-tool";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const ORGANIZATION_ID = "org_1";
const dialect = new PgDialect();
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
  outstanding = {
    organizationBytes: 0,
    organizationRows: 0,
    userBytes: 0,
    userRows: 0,
  },
  presignFails = false,
}: {
  memberRole?: string;
  outstanding?: {
    organizationBytes: number;
    organizationRows: number;
    userBytes: number;
    userRows: number;
  };
  presignFails?: boolean;
} = {}) => {
  const inserted: InsertedRow[][] = [];
  const audited: AuditEvent[] = [];
  const presignedKeys: string[] = [];
  const updates: Record<string, unknown>[] = [];

  const { safeDb, scopedDb } = createScopedDbMock({
    execute: async (query: SQL) =>
      await Promise.resolve(
        dialect
          .sqlToQuery(query)
          .sql.includes("file_comparison_outstanding_capacity()")
          ? [
              {
                organization_bytes: outstanding.organizationBytes,
                organization_rows: outstanding.organizationRows,
                user_bytes: outstanding.userBytes,
                user_rows: outstanding.userRows,
              },
            ]
          : [{ acquired: true, key1: 0x0f_10_cc_ad, key2: 1 }],
      ),
    insert: () => ({
      values: async (rows: InsertedRow[]) => {
        inserted.push(rows);
        await Promise.resolve();
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
          await Promise.resolve();
        },
      }),
    }),
  });

  const context = asTestRaw<AuthorizedMcpRequestContext>({
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
    userEmail: "standard@example.test",
  });

  const dependencies: PrepareFileComparisonDependencies = {
    presignUploadUrl: async ({ key, contentType, sha256Base64 }) => {
      presignedKeys.push(key);
      if (presignFails) {
        return Result.err(
          new S3PresignError({ message: "presign unavailable" }),
        );
      }
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
    outstanding,
    presignedKeys,
    updates,
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

  test("refuses reservations that would exceed the retained row or byte quota", async () => {
    const byRows = createHarness({
      outstanding: {
        organizationBytes: 0,
        organizationRows: 0,
        userBytes: 0,
        userRows: FILE_COMPARISON_OUTSTANDING_ROW_LIMIT - 1,
      },
    });
    const byBytes = createHarness({
      outstanding: {
        organizationBytes: 0,
        organizationRows: 0,
        userBytes: FILE_COMPARISON_OUTSTANDING_BYTE_LIMIT - 1,
        userRows: 0,
      },
    });

    expect(errorOf(await byRows.run(validArgs())).code).toBe("rate_limited");
    expect(errorOf(await byBytes.run(validArgs())).code).toBe("rate_limited");
    expect(byRows.inserted).toHaveLength(0);
    expect(byRows.presignedKeys).toHaveLength(0);
    expect(byBytes.inserted).toHaveLength(0);
    expect(byBytes.presignedKeys).toHaveLength(0);
  });

  test("refuses reservations that would exceed the organization quota", async () => {
    const byRows = createHarness({
      outstanding: {
        organizationBytes: 0,
        organizationRows:
          FILE_COMPARISON_ORGANIZATION_OUTSTANDING_ROW_LIMIT - 1,
        userBytes: 0,
        userRows: 0,
      },
    });
    const byBytes = createHarness({
      outstanding: {
        organizationBytes:
          FILE_COMPARISON_ORGANIZATION_OUTSTANDING_BYTE_LIMIT - 1,
        organizationRows: 0,
        userBytes: 0,
        userRows: 0,
      },
    });

    expect(errorOf(await byRows.run(validArgs())).code).toBe("rate_limited");
    expect(errorOf(await byBytes.run(validArgs())).code).toBe("rate_limited");
    expect(byRows.inserted).toHaveLength(0);
    expect(byBytes.inserted).toHaveLength(0);
  });

  test("admits new files only after cleanup removes retained rows", async () => {
    const harness = createHarness({
      outstanding: {
        organizationBytes: FILE_COMPARISON_OUTSTANDING_BYTE_LIMIT,
        organizationRows: FILE_COMPARISON_OUTSTANDING_ROW_LIMIT,
        userBytes: FILE_COMPARISON_OUTSTANDING_BYTE_LIMIT,
        userRows: FILE_COMPARISON_OUTSTANDING_ROW_LIMIT,
      },
    });

    expect(errorOf(await harness.run(validArgs())).code).toBe("rate_limited");

    // Object deletion alone does not release quota. The sweep deletes the row
    // only after the object, and this census observes that committed removal.
    harness.outstanding.organizationBytes = 0;
    harness.outstanding.organizationRows = 0;
    harness.outstanding.userBytes = 0;
    harness.outstanding.userRows = 0;
    expect(dataOf(await harness.run(validArgs())).next.tool).toBe(
      "compare_documents",
    );
  });

  test("expires both retained rows when presigning fails", async () => {
    const harness = createHarness({ presignFails: true });

    expect(errorOf(await harness.run(validArgs())).code).toBe("internal_error");
    expect(harness.inserted.at(0)).toHaveLength(2);
    expect(harness.updates).toEqual([{ expiresAt: expect.any(Date) }]);
  });
});
