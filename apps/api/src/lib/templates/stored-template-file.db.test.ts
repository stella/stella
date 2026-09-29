/**
 * Stored template and style-set files reach a parser only as a `ScannedFile`.
 * A row written before scan states were recorded is `unscanned`: its first
 * read runs the upload scan, marks the row, and later reads skip the scan. A
 * file the scan rejects, or a scanner that is down, never yields a file.
 * Driven against a real (PGlite) database, a fake object store, and the real
 * scanner; only the outage replaces the scanner.
 */

import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import JSZip from "jszip";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { styleSets, templates, templateVersions } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { adaptAiFields } from "@/api/lib/docx/adapt-ai-fields";
import type { deriveManifestFromDocx } from "@/api/lib/docx/derived-manifest";
import type { discoverClauseSlots } from "@/api/lib/docx/discover-clause-slots";
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import type {
  documentTextForAiFields,
  extractDocxDocument,
  extractTextForPreview,
} from "@/api/lib/docx/extract-text";
import type { fillTemplate } from "@/api/lib/docx/patch-template";
import type { writeFieldFilters } from "@/api/lib/docx/write-field-filters";
import {
  FileScanFailedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import type { readStyleSetEditorPreset } from "@/api/lib/style-set-editor";
import { readStyleSetPackage } from "@/api/lib/style-sets";
import type { configureTemplateDocument } from "@/api/lib/templates/configure-template-document";
import { createStoredTemplate } from "@/api/lib/templates/create-template";
import { buildTemplateS3Key } from "@/api/lib/templates/storage-keys";
import { readStoredTemplateFile } from "@/api/lib/templates/stored-template-file";
import type { FillTemplateSource } from "@/api/lib/templates/template-fill-service";
import { loadStoredTemplateSource } from "@/api/lib/templates/template-fill-service";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { docxWithMarkers } from "@/api/tests/helpers/docx-with-markers";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// ── Compile-time: no parser takes raw bytes ──────────────
//
// Every template and style-set parser input is a `ScannedFile`. Neither raw
// bytes nor an object with the same public members satisfies it (the class
// carries an ES private field), so the only way in is a scan or a stored read.

type Assert<T extends true> = T;
type AllTrue<T extends readonly boolean[]> = T[number] extends true
  ? true
  : false;

type ScannedFileLookalike = Pick<
  ScannedFile,
  "bytes" | "fileName" | "mimeType" | "scanWarnings" | "source" | "withMimeType"
>;

type RefusesRawBytes<Input> = [Buffer] extends [Input]
  ? false
  : [Uint8Array] extends [Input]
    ? false
    : [ArrayBuffer] extends [Input]
      ? false
      : [ScannedFileLookalike] extends [Input]
        ? false
        : true;

type FirstInput<F extends (...args: never[]) => unknown> = Parameters<F>[0];

export type TemplateParsersRefuseRawBytes = Assert<
  AllTrue<
    [
      RefusesRawBytes<FirstInput<typeof discoverTemplate>>,
      RefusesRawBytes<FirstInput<typeof fillTemplate>>,
      RefusesRawBytes<FirstInput<typeof deriveManifestFromDocx>>,
      RefusesRawBytes<FirstInput<typeof discoverClauseSlots>>,
      RefusesRawBytes<FirstInput<typeof extractDocxDocument>>,
      RefusesRawBytes<FirstInput<typeof extractTextForPreview>>,
      RefusesRawBytes<FirstInput<typeof documentTextForAiFields>>,
      RefusesRawBytes<FirstInput<typeof writeFieldFilters>>,
      RefusesRawBytes<FirstInput<typeof readStyleSetEditorPreset>>,
      RefusesRawBytes<FirstInput<typeof adaptAiFields>["file"]>,
      RefusesRawBytes<FirstInput<typeof configureTemplateDocument>["file"]>,
      RefusesRawBytes<FirstInput<typeof createStoredTemplate>["file"]>,
      RefusesRawBytes<FillTemplateSource["file"]>,
    ]
  >
>;

// ── Runtime ──────────────────────────────────────────────

const bucket = envBase.S3_BUCKET;

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
let fake: FakeS3;

beforeAll(async () => {
  ({ testDb, ids } = await getRlsFixture());
  safeDb = asTestRaw<SafeDb>(createSafeDb(testDb, [], ids.orgA, ids.userA1));
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [], ids.orgA, ids.userA1),
  );
  fake = startFakeS3();
}, 120_000);

afterAll(async () => {
  fake.stop();
  await releaseRlsFixture();
});

const expectOk = <T, E>(result: Result<T, E>): T => {
  if (Result.isError(result)) {
    throw new TypeError(`expected success, got ${String(result.error)}`);
  }
  return result.value;
};

const expectErr = <T, E>(result: Result<T, E>): E => {
  if (Result.isOk(result)) {
    throw new TypeError("expected a failure");
  }
  return result.error;
};

/** A DOCX whose only relationship links an external Word template, which
 *  the upload scan rejects. */
const attachedTemplateDocx = async (): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>{{ client_name }}</w:t></w:r></w:p></w:body></w:document>",
  );
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" ' +
      'Target="https://templates.example/remote.dotm" TargetMode="External"/>' +
      "</Relationships>",
  );
  return await zip.generateAsync({ type: "uint8array" });
};

/** A template and its first version naming one stored file, inserted without
 *  a scan state the way rows written before scan states existed read. */
const seedTemplate = async (bytes: Uint8Array): Promise<SafeId<"template">> => {
  const templateId = createSafeId<"template">();
  const s3Key = buildTemplateS3Key(ids.orgA, templateId);
  fake.put(bucket, s3Key, bytes);
  await testDb.insert(templates).values({
    id: templateId,
    organizationId: ids.orgA,
    name: "Scan fixture",
    fileName: "fixture.docx",
    s3Key,
    sizeBytes: bytes.byteLength,
    fieldCount: 0,
    createdBy: ids.userA1,
  });
  await testDb.insert(templateVersions).values({
    id: createSafeId<"templateVersion">(),
    organizationId: ids.orgA,
    templateId,
    version: 1,
    s3Key,
    fieldCount: 0,
    createdBy: ids.userA1,
  });
  return templateId;
};

const templateRow = async (templateId: SafeId<"template">) =>
  (await testDb.query.templates.findFirst({
    where: { id: { eq: templateId } },
    columns: { s3Key: true, scanState: true },
  })) ?? panic(`expected the seeded template ${templateId}`);

const templateScanStates = async (templateId: SafeId<"template">) => ({
  template: (await templateRow(templateId)).scanState,
  versions: (
    await testDb
      .select({ scanState: templateVersions.scanState })
      .from(templateVersions)
      .where(eq(templateVersions.templateId, templateId))
  ).map(({ scanState }) => scanState),
});

/** The real scanner, counting how often it runs. */
const countingScan = () => {
  const scanned: string[] = [];
  const scan: typeof scanUpload = async (input) => {
    scanned.push(input.fileName);
    return await scanUpload(input);
  };
  return { scanned, scan };
};

const scannerDown: typeof scanUpload = async () =>
  await Promise.resolve(
    Result.err(new FileScanFailedError({ message: "scanner down" })),
  );

describe("stored template files", () => {
  test("an existing template is scanned on its first read, marked, and then read without a scan", async () => {
    const templateId = await seedTemplate(
      await docxWithMarkers(["client_name"]),
    );
    expect(await templateScanStates(templateId)).toEqual({
      template: "unscanned",
      versions: ["unscanned"],
    });
    const { scanned, scan } = countingScan();

    const first = expectOk(
      await readStoredTemplateFile({
        safeDb,
        organizationId: ids.orgA,
        row: await templateRow(templateId),
        scan,
      }),
    );

    expect(first.source.type).toBe("scan");
    expect(
      (await discoverTemplate(first)).placeholders.map(({ name }) => name),
    ).toEqual(["client_name"]);
    expect(await templateScanStates(templateId)).toEqual({
      template: "scanned",
      versions: ["scanned"],
    });

    const second = expectOk(
      await readStoredTemplateFile({
        safeDb,
        organizationId: ids.orgA,
        row: await templateRow(templateId),
        scan,
      }),
    );

    expect(second.source.type).toBe("stored");
    expect(scanned).toHaveLength(1);
  });

  test("the fill boundary refuses a template the scan rejects and leaves it unscanned", async () => {
    const templateId = await seedTemplate(await attachedTemplateDocx());

    const error = expectErr(
      await loadStoredTemplateSource({
        templateId,
        organizationId: ids.orgA,
        scopedDb,
      }),
    );

    expect(error.status).toBe(422);
    expect(error.code).toBe(API_FILE_SECURITY_REJECTED_ERROR_CODE);
    expect(error.message).toContain("ooxml_attached_template");
    expect(await templateScanStates(templateId)).toEqual({
      template: "unscanned",
      versions: ["unscanned"],
    });
  });

  test("a scanner outage answers a retryable 503 and leaves the template for the next read", async () => {
    const templateId = await seedTemplate(
      await docxWithMarkers(["client_name"]),
    );

    const error = expectErr(
      await readStoredTemplateFile({
        safeDb,
        organizationId: ids.orgA,
        row: await templateRow(templateId),
        scan: scannerDown,
      }),
    );

    expect(error.status).toBe(503);
    expect(error.code).not.toBe(API_FILE_SECURITY_REJECTED_ERROR_CODE);
    expect(error.hint).toContain("Retry");
    expect(await templateScanStates(templateId)).toEqual({
      template: "unscanned",
      versions: ["unscanned"],
    });

    expectOk(
      await readStoredTemplateFile({
        safeDb,
        organizationId: ids.orgA,
        row: await templateRow(templateId),
      }),
    );
    expect((await templateRow(templateId)).scanState).toBe("scanned");
  });

  test("a template stored from a scanned file is recorded as scanned and read without a scan", async () => {
    const file = expectOk(
      await scanUpload({
        bytes: await docxWithMarkers(["client_name"]),
        declaredMimeType: DOCX_MIME_TYPE,
        fileName: "created.docx",
      }),
    );

    const created = expectOk(
      await Result.gen(() =>
        createStoredTemplate({
          safeDb,
          organizationId: ids.orgA,
          userId: ids.userA1,
          file,
          name: "Created from a scanned file",
          fileName: "created.docx",
          recordAuditEvent: createAuditRecorder({
            organizationId: ids.orgA,
            workspaceId: null,
            userId: ids.userA1,
            request: new Request("https://example.test/templates"),
            server: null,
          }),
        }),
      ),
    );
    const { scanned, scan } = countingScan();

    expect(await templateScanStates(created.id)).toEqual({
      template: "scanned",
      versions: ["scanned"],
    });
    const read = expectOk(
      await readStoredTemplateFile({
        safeDb,
        organizationId: ids.orgA,
        row: await templateRow(created.id),
        scan,
      }),
    );
    expect(read.source.type).toBe("stored");
    expect(scanned).toHaveLength(0);
  });
});

describe("stored style-set files", () => {
  const seedStyleSet = async (
    bytes: Uint8Array,
  ): Promise<SafeId<"styleSet">> => {
    const styleSetId = createSafeId<"styleSet">();
    const s3Key = `${ids.orgA}/style-sets/${styleSetId}/fixture.docx`;
    fake.put(bucket, s3Key, bytes);
    await testDb.insert(styleSets).values({
      id: styleSetId,
      organizationId: ids.orgA,
      name: "Scan fixture",
      fileName: "fixture.docx",
      s3Key,
      sizeBytes: bytes.byteLength,
      createdBy: ids.userA1,
    });
    return styleSetId;
  };

  const styleSetScanState = async (styleSetId: SafeId<"styleSet">) =>
    (
      await testDb
        .select({ scanState: styleSets.scanState })
        .from(styleSets)
        .where(eq(styleSets.id, styleSetId))
    ).at(0)?.scanState ?? panic(`expected the seeded style set ${styleSetId}`);

  test("an existing style set is scanned on its first read, marked, and then read without a scan", async () => {
    const styleSetId = await seedStyleSet(await docxWithMarkers([]));
    const { scanned, scan } = countingScan();

    const first = expectOk(
      await readStyleSetPackage({
        safeDb,
        organizationId: ids.orgA,
        styleSetId,
        scan,
      }),
    );
    expect(first.file.source.type).toBe("scan");
    expect(await styleSetScanState(styleSetId)).toBe("scanned");

    const second = expectOk(
      await readStyleSetPackage({
        safeDb,
        organizationId: ids.orgA,
        styleSetId,
        scan,
      }),
    );
    expect(second.file.source.type).toBe("stored");
    expect(scanned).toHaveLength(1);
  });

  test("a style set the scan rejects is refused and stays unscanned", async () => {
    const styleSetId = await seedStyleSet(await attachedTemplateDocx());

    const error = expectErr(
      await readStyleSetPackage({
        safeDb,
        organizationId: ids.orgA,
        styleSetId,
      }),
    );

    expect(error.status).toBe(422);
    expect(error.code).toBe(API_FILE_SECURITY_REJECTED_ERROR_CODE);
    expect(await styleSetScanState(styleSetId)).toBe("unscanned");
  });
});
