import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { API_FILE_SECURITY_REJECTED_ERROR_CODE } from "@stll/api-contract";

import createTemplate from "@/api/handlers/templates/create";
import { discoverHandler } from "@/api/handlers/templates/discover";
import saveTemplateDocument from "@/api/handlers/templates/document/update";
import { fillHandler } from "@/api/handlers/templates/fill";
import prepareTemplate from "@/api/handlers/templates/prepare";
import { toSafeId } from "@/api/lib/branded-types";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw, readTestJson } from "@/api/tests/helpers/test-tool-set";

// Every route that takes a template DOCX from the caller scans it before
// anything parses or stores it. The context's database handles panic when
// touched, so a 422 here also proves nothing was read or written first.

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const makeAttachedTemplateDocx = async (): Promise<File> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="${W_NS}"><w:body>` +
      `<w:p><w:r><w:t>{{name}}</w:t></w:r></w:p></w:body></w:document>`,
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
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes], "linked.docx", { type: DOCX_MIME_TYPE });
};

type RejectionBody = { code?: string; issues?: { code: string }[] };

const expectSecurityRejection = (body: RejectionBody): void => {
  expect(body.code).toBe(API_FILE_SECURITY_REJECTED_ERROR_CODE);
  expect(body.issues?.map(({ code }) => code)).toContain(
    "ooxml_attached_template",
  );
};

const expectHandlerRejection = (result: unknown): void => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("code" in result) ||
    !("response" in result)
  ) {
    throw new Error("expected a status response");
  }
  expect(result.code).toBe(422);
  expectSecurityRejection(asTestRaw<RejectionBody>(result.response));
};

describe("template uploads are scanned", () => {
  test("create refuses a DOCX the scan rejects", async () => {
    const result = await createTemplate.handler(
      createTestHandlerContext<Parameters<typeof createTemplate.handler>[0]>({
        body: { file: await makeAttachedTemplateDocx(), name: "Linked" },
      }),
    );

    expectHandlerRejection(result);
  });

  test("saving a template document refuses a DOCX the scan rejects", async () => {
    const result = await saveTemplateDocument.handler(
      createTestHandlerContext<
        Parameters<typeof saveTemplateDocument.handler>[0]
      >({
        body: { file: await makeAttachedTemplateDocx() },
        params: {
          templateId: toSafeId<"template">(
            "00000000-0000-4000-8000-000000000001",
          ),
        },
      }),
    );

    expectHandlerRejection(result);
  });

  test("prepare refuses a DOCX the scan rejects", async () => {
    const result = await prepareTemplate.handler(
      createTestHandlerContext<Parameters<typeof prepareTemplate.handler>[0]>({
        body: { file: await makeAttachedTemplateDocx() },
      }),
    );

    expectHandlerRejection(result);
  });

  test("discover refuses a DOCX the scan rejects", async () => {
    const response = await discoverHandler({
      organizationId: toSafeId<"organization">("org_test"),
      body: { file: await makeAttachedTemplateDocx() },
    });

    if (!(response instanceof Response)) {
      throw new Error("expected a Response");
    }
    expect(response.status).toBe(422);
    expectSecurityRejection(await readTestJson<RejectionBody>(response));
  });

  test("fill refuses a DOCX the scan rejects", async () => {
    const context = createTestHandlerContext();
    const response = await fillHandler({
      safeDb: context.safeDb,
      scopedDb: context.scopedDb,
      organizationId: context.session.activeOrganizationId,
      userId: context.user.id,
      query: {},
      body: { file: await makeAttachedTemplateDocx(), values: "{}" },
    });

    expect(response.status).toBe(422);
    expectSecurityRejection(await readTestJson<RejectionBody>(response));
  });
});
