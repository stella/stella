import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { CompareResult } from "@stll/folio-core";

import { toSafeId } from "@/api/lib/branded-types";
import type {
  ScanFinding,
  ScanResult,
  ScanVerdict,
} from "@/api/lib/file-scan/types";
import type { McpRequestContext } from "@/api/mcp/context";
import { runFileComparison } from "@/api/mcp/file-comparison-run";
import type { FileComparisonRunDependencies } from "@/api/mcp/file-comparison-run";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const ORGANIZATION_ID = "org_1";
const BASE_UPLOAD_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_UPLOAD_ID = "22222222-2222-4222-8222-222222222222";

const BASE_BYTES = new Uint8Array([1, 2, 3, 4]);
const TARGET_BYTES = new Uint8Array([5, 6, 7, 8, 9]);

const sha256Of = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const hexToBase64 = (hex: string): string =>
  Buffer.from(hex, "hex").toString("base64");

type Row = {
  declaredName: string;
  declaredSha256: string | null;
  declaredSize: number;
  id: string;
};

const inputRow = (id: string, bytes: Uint8Array, name: string): Row => ({
  declaredName: name,
  declaredSha256: sha256Of(bytes),
  declaredSize: bytes.byteLength,
  id,
});

const comparedResult = (changeKinds: string[]): CompareResult =>
  asTestRaw<CompareResult>({
    buffer: new Uint8Array([42, 42]).buffer,
    changes: changeKinds.map((kind) => ({ kind })),
    compatibility: { status: "standard-ooxml" },
    unsupported: [],
    verification: { status: "verified" },
  });

const SCAN_FINDING = {
  reject: {
    rule: "corrupt-zip",
    severity: "reject",
    message: "not a zip",
  },
  warn: {
    rule: "macro-present",
    severity: "warn",
    message: "carries a macro",
  },
} as const satisfies Record<"reject" | "warn", ScanFinding>;

const scanResult = (verdict: ScanVerdict): ScanResult =>
  verdict === "pass"
    ? { verdict, findings: [] }
    : { verdict, findings: [SCAN_FINDING[verdict]] };

type HarnessOptions = {
  bytesByKey?: Record<string, Uint8Array>;
  deleteFails?: boolean;
  headChecksum?: "match" | "absent" | "mismatch";
  headSizes?: Record<string, number>;
  rows?: Row[];
  scanVerdict?: ScanVerdict;
};

const createHarness = ({
  bytesByKey,
  deleteFails = false,
  headChecksum = "match",
  headSizes,
  rows = [
    inputRow(BASE_UPLOAD_ID, BASE_BYTES, "Draft.docx"),
    inputRow(TARGET_UPLOAD_ID, TARGET_BYTES, "Revised.docx"),
  ],
  scanVerdict = "pass",
}: HarnessOptions = {}) => {
  const deletedKeys: string[] = [];
  const putKeys: string[] = [];
  const insertedRows: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const deletedRows = { count: 0 };
  const audited: { metadata?: Record<string, unknown> }[] = [];

  const keyOf = (id: string) => `${ORGANIZATION_ID}/tmp/comparisons/${id}`;
  const bytes =
    bytesByKey ??
    ({
      [keyOf(BASE_UPLOAD_ID)]: BASE_BYTES,
      [keyOf(TARGET_UPLOAD_ID)]: TARGET_BYTES,
    } satisfies Record<string, Uint8Array>);

  const { safeDb, scopedDb } = createScopedDbMock({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => await Promise.resolve(rows) }),
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        insertedRows.push(row);
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
    delete: () => ({
      where: async () => {
        deletedRows.count += 1;
        await Promise.resolve();
      },
    }),
  });

  const context = asTestRaw<McpRequestContext>({
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    recordAuditEvent: async (
      _tx: unknown,
      event: { metadata?: Record<string, unknown> },
    ) => {
      audited.push(event);
      await Promise.resolve();
    },
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
  });

  const dependencies: FileComparisonRunDependencies = {
    compareDocxBuffers: async () =>
      await Promise.resolve(Result.ok(comparedResult(["insert", "delete"]))),
    deleteObject: async (key) => {
      if (deleteFails) {
        throw new Error("s3 delete failed");
      }
      deletedKeys.push(key);
      await Promise.resolve();
    },
    headObject: async (key) => {
      const stored = bytes[key];
      if (stored === undefined) {
        return await Promise.resolve(
          Result.err(asTestRaw<never>({ message: "missing" })),
        );
      }
      const declared = sha256Of(stored);
      const checksum =
        headChecksum === "absent"
          ? null
          : hexToBase64(
              headChecksum === "mismatch"
                ? sha256Of(new Uint8Array([0]))
                : declared,
            );
      return await Promise.resolve(
        Result.ok({
          contentLength: headSizes?.[key] ?? stored.byteLength,
          checksumSHA256: checksum,
        }),
      );
    },
    presignDownloadUrl: async (key) =>
      await Promise.resolve(`https://s3.example/${key}?signed`),
    putObject: async (key) => {
      putKeys.push(key);
      await Promise.resolve();
    },
    readObject: async (key) => {
      const stored = bytes[key];
      if (stored === undefined) {
        throw new Error("missing object");
      }
      return await Promise.resolve(new Uint8Array(stored).buffer);
    },
    resolveDocxEditAuthorName: async () => await Promise.resolve("Jane Doe"),
    scanFile: async () =>
      await Promise.resolve(Result.ok(scanResult(scanVerdict))),
  };

  return {
    audited,
    deletedKeys,
    deletedRows,
    insertedRows,
    keyOf,
    putKeys,
    updates,
    run: async (
      overrides: Partial<Parameters<typeof runFileComparison>[0]> = {},
    ) =>
      await runFileComparison(
        {
          baseTrackedChanges: "accept",
          baseUploadId: toSafeId<"fileComparisonUpload">(BASE_UPLOAD_ID),
          context,
          granularity: "word",
          mode: "strict",
          outputMode: "download",
          signal: AbortSignal.any([]),
          targetTrackedChanges: "accept",
          targetUploadId: toSafeId<"fileComparisonUpload">(TARGET_UPLOAD_ID),
          ...overrides,
        },
        dependencies,
      ),
  };
};

type RunOutcome = Awaited<ReturnType<typeof runFileComparison>>;

const resultOf = (outcome: RunOutcome) => {
  if (outcome.status !== "ok") {
    throw new Error(`Expected a result, got ${JSON.stringify(outcome)}`);
  }
  return outcome.result;
};

const errorOf = (outcome: RunOutcome) => {
  if (
    outcome.status !== "error" ||
    outcome.response.error.type !== "structured"
  ) {
    throw new Error(
      `Expected a structured error, got ${JSON.stringify(outcome)}`,
    );
  }
  return outcome.response.error;
};

describe("compare_documents uploads source", () => {
  test("writes the redline, returns a link, and deletes both inputs", async () => {
    const harness = createHarness();

    const result = resultOf(await harness.run());

    expect(result.status).toBe("upload_downloadable");
    if (result.status !== "upload_downloadable") {
      return;
    }
    expect(result.fileName).toBe("Revised redline.docx");
    expect(result.download.downloadUrl).toContain("signed");
    expect(harness.putKeys).toHaveLength(1);
    // The redline row exists before its object, so the key always has a name.
    expect(harness.insertedRows.at(0)).toMatchObject({ kind: "redline" });
    expect(harness.deletedKeys).toEqual(
      expect.arrayContaining([
        harness.keyOf(BASE_UPLOAD_ID),
        harness.keyOf(TARGET_UPLOAD_ID),
      ]),
    );
    expect(harness.deletedRows.count).toBe(2);
    expect(harness.audited.at(0)?.metadata).toMatchObject({
      baseSizeBytes: BASE_BYTES.byteLength,
      changeCount: 2,
      targetSizeBytes: TARGET_BYTES.byteLength,
    });
  });

  test("preview compares without writing a redline object", async () => {
    const harness = createHarness();

    const result = resultOf(await harness.run({ outputMode: "preview" }));

    expect(result.status).toBe("upload_previewed");
    expect(harness.putKeys).toHaveLength(0);
    expect(harness.insertedRows).toHaveLength(0);
    // The inputs are still consumed: the caller asked for them to be read.
    expect(harness.deletedRows.count).toBe(2);
  });

  test("refuses an upload id that is not the caller's live input", async () => {
    // The scoped query returns nothing: another user's row, a consumed row and
    // an expired row are all filtered by the same predicate.
    const harness = createHarness({ rows: [] });

    const error = errorOf(await harness.run());

    expect(error.code).toBe("not_found");
    expect(error.hint).toContain("prepare_file_comparison");
    expect(harness.putKeys).toHaveLength(0);
  });

  test("refuses a size that disagrees with what was declared", async () => {
    const harness = createHarness({
      headSizes: {
        [`${ORGANIZATION_ID}/tmp/comparisons/${BASE_UPLOAD_ID}`]: 99,
      },
    });

    const error = errorOf(await harness.run());

    expect(error.code).toBe("validation_error");
    expect(error.issues?.map(({ path }) => path)).toContain(
      "source.base_upload_id",
    );
    expect(harness.updates.at(0)).toMatchObject({ status: "failed" });
    expect(harness.putKeys).toHaveLength(0);
  });

  test("refuses a checksum that disagrees with what was declared", async () => {
    const harness = createHarness({ headChecksum: "mismatch" });

    const error = errorOf(await harness.run());

    expect(error.code).toBe("validation_error");
    expect(error.message).toContain("SHA-256");
    expect(harness.putKeys).toHaveLength(0);
  });

  test("hashes the bytes itself when the store recorded no checksum", async () => {
    const harness = createHarness({ headChecksum: "absent" });

    const result = resultOf(await harness.run());

    expect(result.status).toBe("upload_downloadable");
  });

  test("marks a rejected scan failed, deletes the object, and names the rule", async () => {
    const harness = createHarness({ scanVerdict: "reject" });

    const error = errorOf(await harness.run());

    expect(error.code).toBe("validation_error");
    expect(error.issues?.at(0)?.message).toContain("corrupt-zip");
    expect(harness.updates.at(0)).toMatchObject({ status: "failed" });
    expect(harness.deletedKeys.length).toBeGreaterThan(0);
    expect(harness.putKeys).toHaveLength(0);
  });

  test("surfaces a warning verdict instead of refusing the comparison", async () => {
    const harness = createHarness({ scanVerdict: "warn" });

    const result = resultOf(await harness.run());

    expect(result.status).toBe("upload_downloadable");
    if (result.status !== "upload_downloadable") {
      return;
    }
    expect(result.scanWarnings).toEqual(["carries a macro", "carries a macro"]);
  });

  test("leaves the row behind when the object delete fails, for the sweep", async () => {
    const harness = createHarness({ deleteFails: true });

    const result = resultOf(await harness.run());

    expect(result.status).toBe("upload_downloadable");
    // Expired now rather than on the original deadline, so the next sweep
    // tick retries the key instead of waiting the row out.
    expect(harness.updates.at(0)).toMatchObject({ status: "consumed" });
    expect(harness.deletedRows.count).toBe(0);
  });

  test("refuses comparing one staged file with itself", async () => {
    const harness = createHarness();

    const error = errorOf(
      await harness.run({
        targetUploadId: toSafeId<"fileComparisonUpload">(BASE_UPLOAD_ID),
      }),
    );

    expect(error.code).toBe("validation_error");
    expect(error.issues?.map(({ path }) => path)).toContain(
      "source.target_upload_id",
    );
  });
});
