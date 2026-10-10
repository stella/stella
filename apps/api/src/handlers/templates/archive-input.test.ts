import { Result } from "better-result";
import { expect, test } from "bun:test";
import JSZip from "jszip";

import uploadSkill from "@/api/handlers/skills/upload";
import fillTemplate from "@/api/handlers/templates/fill";
import prepareTemplate from "@/api/handlers/templates/prepare";
import { DocxArchiveError, validateDocxArchive } from "@/api/lib/docx-archive";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import {
  NO_AUDIT,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const { safeDb, scopedDb } = createScopedDbMock({});

test("archive entry validation returns a client response before parsing", async () => {
  const bytes = new TextEncoder().encode("Invalid document.");
  const validated = await validateDocxArchive(bytes);
  expect(Result.isError(validated)).toBe(true);
  if (Result.isError(validated)) {
    expect(validated.error.status).toBe(422);
    expect(validated.error.cause).toBeInstanceOf(DocxArchiveError);
    expect(validated.error.cause).toMatchObject({ reason: "load-failed" });
  }
  const file = new File([bytes], "input.docx", { type: DOCX_MIME_TYPE });
  const filled = await fillTemplate.handler(
    createTestHandlerContext<Parameters<typeof fillTemplate.handler>[0]>({
      audit: NO_AUDIT,
      safeDb,
      scopedDb,
      body: { file, values: "{}" },
      query: {},
    }),
  );
  expect(filled).toBeInstanceOf(Response);
  if (filled instanceof Response) {
    expect(filled.status).toBe(422);
    expect(await filled.json()).toMatchObject({ message: "Invalid archive" });
  }

  const prepared = await prepareTemplate.handler(
    createTestHandlerContext<Parameters<typeof prepareTemplate.handler>[0]>({
      audit: NO_AUDIT,
      safeDb,
      scopedDb,
      body: { file },
    }),
  );
  expect(prepared).toMatchObject({
    code: 422,
    response: { message: "Invalid archive" },
  });

  const uploaded = await uploadSkill.handler(
    createTestHandlerContext<Parameters<typeof uploadSkill.handler>[0]>({
      audit: NO_AUDIT,
      safeDb,
      scopedDb,
      memberRole: sessionMemberRole("member"),
      body: {
        scope: "private",
        file: new File([bytes], "input.zip", { type: "application/zip" }),
      },
    }),
  );
  expect(uploaded).toMatchObject({
    code: 422,
    response: { message: "Invalid archive" },
  });
});

test("archive validation applies configured limits", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", "<document/>", { createFolders: false });
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "STORE",
  });
  const accepted = await validateDocxArchive(bytes, {
    maxEntries: 1,
    maxEntryBytes: 16,
    maxTotalBytes: 16,
  });
  expect(Result.isOk(accepted)).toBe(true);
  const limited = await validateDocxArchive(bytes, {
    maxEntries: 1,
    maxEntryBytes: 8,
    maxTotalBytes: 16,
  });
  expect(Result.isError(limited)).toBe(true);
  if (Result.isError(limited)) {
    expect(limited.error.status).toBe(422);
    expect(limited.error.cause).toBeInstanceOf(DocxArchiveError);
  }
});
