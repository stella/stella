import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  PDF_PAGE_FIELD_ROW_CLASS,
  PDF_ZOOM_GROUP_CLASS,
  PdfLoadingShell,
  PdfToolbarFace,
} from "@/components/pdf/pdf-viewer.pending";
import { DOCX_MIME, PDF_MIME, XLSX_MIME } from "@/lib/consts";
import { fileMetadataQueryKey } from "@/lib/files/file-metadata-query.logic";
import { toSafeId } from "@/lib/safe-id";
import type { EntityField } from "@/lib/types";
import { entityDetailKey } from "@/lib/workspaces/queries/entity-keys.logic";
import { cachedDocumentPageSheet } from "@/routes/_protected.workspaces/$workspaceId/-components/document/document-page-pending.logic";
import type { DocumentPageSheet } from "@/routes/_protected.workspaces/$workspaceId/-components/document/document-page-pending.logic";

const workspaceId = "workspace-1";
const entityId = "entity-1";
const fieldId = "field-1";

const fileField = (mimeType: string): EntityField => ({
  id: toSafeId<"field">(fieldId),
  propertyId: toSafeId<"property">("property-1"),
  content: {
    version: 1,
    type: "file",
    id: toSafeId<"userFile">("file-1"),
    fileName: "contract",
    mimeType,
    sizeBytes: 10,
    encrypted: false,
    sha256Hex: "0".repeat(64),
    pdfFileId: null,
  },
});

const cacheWith = (mimeType: string | null) => {
  const queryClient = new QueryClient();
  if (mimeType !== null) {
    queryClient.setQueryData(entityDetailKey(workspaceId, entityId), {
      fields: [fileField(mimeType)],
    });
  }
  return queryClient;
};

const search = { entity: entityId, field: fieldId };

describe("the document page's loading sheet", () => {
  test("is the DOCX sheet for a Word document and an office file", () => {
    expect(
      cachedDocumentPageSheet(cacheWith(DOCX_MIME), workspaceId, search),
    ).toEqual({ type: "docx" });
    expect(
      cachedDocumentPageSheet(cacheWith(XLSX_MIME), workspaceId, search),
    ).toEqual({ type: "office" });
  });

  test("is the PDF sheet, never the DOCX one, for a PDF", () => {
    expect(
      cachedDocumentPageSheet(cacheWith(PDF_MIME), workspaceId, search),
    ).toEqual({ type: "pdf", colorMode: "system" });
    expect(
      cachedDocumentPageSheet(cacheWith(PDF_MIME), workspaceId, {
        ...search,
        pdfColorMode: "dark",
      }),
    ).toEqual({ type: "pdf", colorMode: "dark" });
  });

  test("leaves the colour control out where the PDF was made from an image", () => {
    expect(
      cachedDocumentPageSheet(cacheWith("image/png"), workspaceId, search),
    ).toEqual({ type: "pdf", colorMode: undefined });
    const scanned = cacheWith(PDF_MIME);
    scanned.setQueryData(fileMetadataQueryKey({ fieldId, workspaceId }), {
      originalMimeType: "image/jpeg",
    });
    expect(cachedDocumentPageSheet(scanned, workspaceId, search)).toEqual({
      type: "pdf",
      colorMode: undefined,
    });
  });

  test("is read from the version history for an older version's file", () => {
    const queryClient = cacheWith(DOCX_MIME);
    queryClient.setQueryData(
      [...entityDetailKey(workspaceId, entityId), "versions"],
      {
        versions: [
          {
            file: {
              fieldId: "field-old",
              propertyId: "property-1",
              fileName: "contract",
              mimeType: PDF_MIME,
              sizeBytes: 10,
            },
          },
        ],
      },
    );
    expect(
      cachedDocumentPageSheet(queryClient, workspaceId, {
        ...search,
        field: "field-old",
      }),
    ).toEqual({ type: "pdf", colorMode: "system" });
  });

  test("is read from a field's own lookup past the history's first page", () => {
    const queryClient = cacheWith(DOCX_MIME);
    const versionsKey = [...entityDetailKey(workspaceId, entityId), "versions"];
    queryClient.setQueryData(versionsKey, { versions: [] });
    queryClient.setQueryData([...versionsKey, "field-file", "field-older"], {
      file: { propertyId: "property-1", fileName: "deed", mimeType: XLSX_MIME },
    });
    expect(
      cachedDocumentPageSheet(queryClient, workspaceId, {
        ...search,
        field: "field-older",
      }),
    ).toEqual({ type: "office" });
    expect(
      cachedDocumentPageSheet(queryClient, workspaceId, {
        ...search,
        field: "field-elsewhere",
      }),
    ).toEqual({ type: "unknown" });
  });

  test("is not claimed where the cache cannot say, or the pane depends on loaded data", () => {
    const unknown: DocumentPageSheet = { type: "unknown" };
    expect(cachedDocumentPageSheet(null, workspaceId, search)).toEqual(unknown);
    expect(
      cachedDocumentPageSheet(cacheWith(null), workspaceId, search),
    ).toEqual(unknown);
    expect(
      cachedDocumentPageSheet(cacheWith(PDF_MIME), workspaceId, {
        ...search,
        field: "another-field",
      }),
    ).toEqual(unknown);
    expect(
      cachedDocumentPageSheet(cacheWith(DOCX_MIME), workspaceId, {
        ...search,
        pane: "review",
      }),
    ).toEqual(unknown);
    expect(
      cachedDocumentPageSheet(cacheWith(PDF_MIME), workspaceId, {
        ...search,
        pdfMode: "organize",
      }),
    ).toEqual(unknown);
  });
});

describe("the PDF toolbar's loading face", () => {
  test("draws the zoom group, page field and actions with nothing to focus", () => {
    const markup = renderToStaticMarkup(
      <PdfToolbarFace colorMode="system" page={3} />,
    );
    expect(markup).toContain(`class="${PDF_ZOOM_GROUP_CLASS}"`);
    expect(markup).toContain(`class="${PDF_PAGE_FIELD_ROW_CLASS}"`);
    // Zoom out, in, reset, colour mode, previous, next, print, translate.
    expect(markup.split('data-slot="button-face"').length - 1).toBe(8);
    expect(markup).toContain(">3<");
    expect(markup).not.toMatch(/<(button|input|a)\b|tabindex=/u);
  });

  test("leaves the colour control out when the PDF has none", () => {
    const markup = renderToStaticMarkup(
      <PdfToolbarFace colorMode={undefined} page={1} />,
    );
    expect(markup.split('data-slot="button-face"').length - 1).toBe(7);
  });

  test("draws one page placeholder in the viewer's surface", () => {
    const markup = renderToStaticMarkup(<PdfLoadingShell />);
    expect(markup).toContain("document-preview-surface");
    expect(markup).toContain("aspect-[210/297]");
  });
});
