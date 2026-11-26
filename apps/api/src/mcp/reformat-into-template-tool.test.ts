import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { toSafeId } from "@/api/lib/branded-types";
import type { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { scanFile } from "@/api/lib/file-scan/scan";
import { folioTemplatePlanEngine } from "@/api/lib/templates/house-style/folio-engine";
import { handleReformatIntoTemplateTool } from "@/api/mcp/reformat-into-template-tool";
import type { ReformatIntoTemplateDependencies } from "@/api/mcp/reformat-into-template-tool";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

// Invented documents, built part by part.
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const PACKAGE = "http://schemas.openxmlformats.org/package/2006";
const OFFICE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORD = "application/vnd.openxmlformats-officedocument.wordprocessingml";

const docx = async ({
  body,
  styles,
  numbering,
}: {
  body: string;
  styles: string;
  numbering: string;
}): Promise<Uint8Array> => {
  const zip = new ZipArchive();
  const parts = {
    "[Content_Types].xml": `${XML}<Types xmlns="${PACKAGE}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${WORD}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${WORD}.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="${WORD}.numbering+xml"/></Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${OFFICE}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${OFFICE}/numbering" Target="numbering.xml"/></Relationships>`,
    "word/document.xml": `${XML}<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    "word/styles.xml": `${XML}<w:styles ${W}>${styles}</w:styles>`,
    "word/numbering.xml": `${XML}<w:numbering ${W}>${numbering}</w:numbering>`,
  };
  for (const [path, content] of Object.entries(parts)) {
    zip.set(path, content);
  }
  return await zip.generate();
};

const run = (text: string) =>
  `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (text: string, properties = ""): string =>
  `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}${run(text)}</w:p>`;
const styled = (styleId: string): string => `<w:pStyle w:val="${styleId}"/>`;
const listed = (numId: number, ilvl: number): string =>
  `<w:numPr><w:ilvl w:val="${String(ilvl)}"/><w:numId w:val="${String(numId)}"/></w:numPr>`;
const style = (styleId: string, name: string, properties = ""): string =>
  `<w:style w:type="paragraph" w:styleId="${styleId}"><w:name w:val="${name}"/>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}</w:style>`;
const level = (
  ilvl: number,
  numFmt: string,
  lvlText: string,
  pStyle = "",
): string =>
  `<w:lvl w:ilvl="${String(ilvl)}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/>${pStyle === "" ? "" : `<w:pStyle w:val="${pStyle}"/>`}<w:lvlText w:val="${lvlText}"/></w:lvl>`;
const list = (id: number, levels: string): string =>
  `<w:abstractNum w:abstractNumId="${String(id)}"><w:multiLevelType w:val="multilevel"/>${levels}</w:abstractNum>`;
const instance = (numId: number, abstractNumId: number): string =>
  `<w:num w:numId="${String(numId)}"><w:abstractNumId w:val="${String(abstractNumId)}"/></w:num>`;
const NORMAL =
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>';

const template = async () =>
  await docx({
    body: [
      paragraph("AGREEMENT", styled("Title")),
      paragraph("Heading", styled("Article")),
      paragraph("Clause text.", styled("Clause1")),
    ].join(""),
    styles: [
      NORMAL,
      style("Title", "Title"),
      style("Body", "Body Text"),
      style("Article", "Article heading", listed(1, 0)),
      style("Clause1", "Clause 1.1", listed(1, 1)),
    ].join(""),
    numbering:
      list(
        0,
        level(0, "decimal", "Article %1", "Article") +
          level(1, "decimal", "%1.%2.", "Clause1") +
          level(2, "lowerLetter", "(%3)"),
      ) + instance(1, 0),
  });

/** A short agreement; `tracked` adds an insertion nobody accepted yet. */
const source = async ({ tracked = false }: { tracked?: boolean } = {}) =>
  await docx({
    body: [
      paragraph("SERVICES AGREEMENT"),
      paragraph("Article 1"),
      paragraph("Scope"),
      paragraph("The supplier provides the services.", listed(1, 0)),
      tracked
        ? `<w:p><w:pPr>${listed(1, 0)}</w:pPr>${run("The customer pays ")}<w:ins w:id="1" w:author="Reviewer" w:date="2026-01-01T00:00:00Z">${run("the agreed ")}</w:ins>${run("fee.")}</w:p>`
        : paragraph("The customer pays the fee.", listed(1, 0)),
      paragraph("A closing sentence."),
    ].join(""),
    styles: NORMAL,
    numbering: list(0, level(0, "decimal", "1.%1.")) + instance(1, 0),
  });

const ORGANIZATION_ID = toSafeId<"organization">("org_1");
const WORKSPACE_ID = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000001",
);
const ENTITY_ID = "00000000-0000-4000-8000-000000000002";
const VERSION_ID = toSafeId<"entityVersion">(
  "00000000-0000-4000-8000-000000000003",
);
const TEMPLATE_ID = toSafeId<"template">(
  "00000000-0000-4000-8000-000000000004",
);
const NEW_ENTITY_ID = toSafeId<"entity">(
  "00000000-0000-4000-8000-000000000005",
);
const NEW_VERSION_ID = toSafeId<"entityVersion">(
  "00000000-0000-4000-8000-000000000006",
);

type Created = Parameters<typeof createEntityFromBuffer>[0];

const harness = async ({
  tracked = false,
  candidates = [
    {
      id: TEMPLATE_ID,
      name: "Agreement",
      tags: ["house-style"],
      whenToUse: "Service agreements",
      whenNotToUse: null,
    },
  ],
}: {
  tracked?: boolean;
  candidates?: Awaited<
    ReturnType<ReformatIntoTemplateDependencies["listHouseStyleTemplates"]>
  >;
} = {}) => {
  const created: Created[] = [];
  const { safeDb, scopedDb } = createScopedDbMock({
    query: {
      entities: {
        findFirst: async () =>
          await Promise.resolve({
            workspaceId: WORKSPACE_ID,
            kind: "document",
            name: "Services agreement",
          }),
      },
    },
  });
  const context = asTestRaw<AuthorizedMcpRequestContext>({
    accessibleWorkspaceIds: [WORKSPACE_ID],
    accessibleWorkspaceIdSet: new Set<string>([WORKSPACE_ID]),
    accessibleWorkspaceStatusById: new Map([[WORKSPACE_ID, "active"]]),
    accessibleWorkspaces: [],
    grantedScopes: ["stella:documents_write", "stella:templates"],
    memberRole: "owner",
    organizationId: ORGANIZATION_ID,
    recordAuditEvent: async () => {
      await Promise.resolve();
    },
    safeDb,
    scopedDb,
    userId: toSafeId<"user">("user_1"),
    userEmail: "standard@example.test",
  });
  const sourceBytes = await source({ tracked });
  const templateBytes = await template();
  const dependencies: ReformatIntoTemplateDependencies = {
    engine: folioTemplatePlanEngine,
    loadSourceDocument: async () =>
      await Promise.resolve({
        status: "ok" as const,
        source: {
          entityId: toSafeId<"entity">(ENTITY_ID),
          workspaceId: WORKSPACE_ID,
          parentId: null,
          versionId: VERSION_ID,
          fileName: "Services agreement.docx",
          bytes: sourceBytes,
        },
      }),
    listHouseStyleTemplates: async () => await Promise.resolve(candidates),
    loadStoredTemplateSource: async () =>
      await Promise.resolve(
        Result.ok({
          name: "Agreement",
          fileName: "agreement.docx",
          templateId: TEMPLATE_ID,
          file: asTestRaw({ bytes: templateBytes.slice().buffer }),
        }),
      ),
    scanFile: asTestRaw<typeof scanFile>(
      async () =>
        await Promise.resolve(Result.ok({ verdict: "accept", findings: [] })),
    ),
    createEntityFromBuffer: async (input) => {
      created.push(input);
      return await Promise.resolve(
        Result.ok({
          entityId: NEW_ENTITY_ID,
          entityVersionId: NEW_VERSION_ID,
          fieldId: toSafeId<"field">("00000000-0000-4000-8000-000000000007"),
          fileName: input.fileName,
          renamed: false,
        }),
      );
    },
  };
  return { context, created, dependencies };
};

describe("reformat_into_template", () => {
  test("saves the document on the house-style template beside its source and returns the note", async () => {
    const { context, created, dependencies } = await harness();
    const result = await handleReformatIntoTemplateTool(
      { args: { entity_id: ENTITY_ID }, context },
      dependencies,
    );

    if (result.status !== "success") {
      throw new Error(JSON.stringify(result));
    }
    expect(result.data).toMatchObject({
      entityId: NEW_ENTITY_ID,
      entityVersionId: NEW_VERSION_ID,
      fileName: "Services agreement (Agreement).docx",
      template: {
        templateId: TEMPLATE_ID,
        name: "Agreement",
        selection: "automatic",
      },
      note: {
        numbering: "keep_source",
        counts: { paragraphsPlaced: 6, labelsWrittenAsText: 0 },
        itemsOmitted: 0,
      },
    });

    // One new document, in the source's folder; the source is only read.
    expect(created).toHaveLength(1);
    const [saved] = created;
    expect(saved?.workspaceId).toBe(WORKSPACE_ID);
    expect(saved?.parentId).toBeNull();
    const output = (
      await folioTemplatePlanEngine.analyze(
        new Uint8Array(saved?.buffer ?? new ArrayBuffer(0)),
      )
    ).unwrap();
    const shown = output.blocks.map(({ label, text }) =>
      label === null ? text : `${label} ${text}`,
    );
    expect(shown).toContain("1.1. The supplier provides the services.");
    expect(shown).toContain("1.2. The customer pays the fee.");
  });

  test("refuses a document with tracked changes by name and saves nothing", async () => {
    const { context, created, dependencies } = await harness({
      tracked: true,
    });
    const result = await handleReformatIntoTemplateTool(
      { args: { entity_id: ENTITY_ID, template_id: TEMPLATE_ID }, context },
      dependencies,
    );

    expect(result).toMatchObject({
      status: "error",
      error: {
        type: "structured",
        code: "validation_error",
        issues: [expect.objectContaining({ code: "tracked_changes" })],
      },
    });
    expect(created).toEqual([]);
  });

  test("asks for the template when several fit the document equally", async () => {
    const { context, created, dependencies } = await harness({
      candidates: ["First", "Second"].map((name, index) => ({
        id: toSafeId<"template">(
          `00000000-0000-4000-8000-00000000001${String(index)}`,
        ),
        name,
        tags: ["house-style"],
        whenToUse: null,
        whenNotToUse: null,
      })),
    });
    const result = await handleReformatIntoTemplateTool(
      { args: { entity_id: ENTITY_ID }, context },
      dependencies,
    );

    expect(result).toMatchObject({
      status: "error",
      error: { code: "validation_error" },
    });
    expect(created).toEqual([]);
  });
});
