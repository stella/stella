import { Result } from "better-result";
import { expect, test } from "bun:test";

import uploadSkill from "@/api/handlers/skills/upload";
import fillTemplate from "@/api/handlers/templates/fill";
import prepareTemplate from "@/api/handlers/templates/prepare";
import {
  DOCX_MAX_ENTRY_BYTES,
  DocxArchiveError,
  validateDocxArchive,
} from "@/api/lib/docx-archive";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { archiveWithDeclaredSize } from "@/api/tests/helpers/archive-input";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const { safeDb, scopedDb } = createScopedDbMock({});

test("archive entry validation returns a client response before parsing", async () => {
  const bytes = await archiveWithDeclaredSize(DOCX_MAX_ENTRY_BYTES + 1);
  expect(bytes.byteLength).toBeLessThan(1024);
  const validated = await validateDocxArchive(bytes);
  expect(Result.isError(validated)).toBe(true);
  if (Result.isError(validated)) {
    expect(validated.error.status).toBe(422);
    expect(validated.error.cause).toBeInstanceOf(DocxArchiveError);
    expect(validated.error.cause).toMatchObject({ reason: "entry-too-large" });
  }
  const changed = await validateDocxArchive(await archiveWithDeclaredSize(1));
  expect(Result.isError(changed)).toBe(true);
  if (Result.isError(changed)) {
    expect(changed.error.cause).toMatchObject({ reason: "load-failed" });
  }

  const file = new File([bytes], "input.docx", { type: DOCX_MIME_TYPE });
  const filled = await fillTemplate.handler(
    createTestHandlerContext<Parameters<typeof fillTemplate.handler>[0]>({
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
      safeDb,
      scopedDb,
      memberRole: { role: "member" },
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
