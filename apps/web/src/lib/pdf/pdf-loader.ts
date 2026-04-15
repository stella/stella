import { Result } from "better-result";
import { getDocument, PasswordResponses } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

import { DEFAULT_PDF_WIDTH } from "@/lib/pdf/consts";
import { parseAttachments } from "@/lib/pdf/parse-attachments";
import type { PDFAttachment } from "@/lib/pdf/parse-attachments";
import type { PageInfo } from "@/lib/pdf/pdf-context";
import { PDFViewerError } from "@/lib/pdf/pdf-errors";
import type { PDFViewerCode } from "@/lib/pdf/pdf-errors";
import { getPageId } from "@/lib/pdf/utils";

export type PDFDocument = {
  document: PDFDocumentProxy;
  attachmentDocuments: PDFDocumentProxy[];
  pages: Map<string, PageInfo>;
  attachmentLabels: Map<string, string>;
  isXfa: boolean;
  baseScale: number;
  toJSON: () => {
    attachmentCount: number;
    attachmentLabelCount: number;
    baseScale: number;
    isXfa: boolean;
    pageCount: number;
  };
};

/**
 * PDF.js throws `PasswordException` internally, but `pdfjs-dist` does not
 * export that class from `build/pdf.mjs`
 */
const isPasswordException = (
  error: unknown,
): error is Error & { code: number } => {
  if (!(error instanceof Error) || error.name !== "PasswordException") {
    return false;
  }
  return "code" in error && typeof error.code === "number";
};

const parsePasswordException = (
  error: unknown,
): { code: PDFViewerCode; message: string } | null => {
  if (!isPasswordException(error)) {
    return null;
  }

  return {
    code:
      error.code === PasswordResponses.INCORRECT_PASSWORD
        ? "INCORRECT_PASSWORD"
        : "PASSWORD_REQUIRED",
    message: error.message,
  };
};

const loadPortfolioPages = async (
  instanceId: string,
  pdfAttachments: PDFAttachment[],
): Promise<{
  documentPages: Promise<{ id: string; proxy: PDFPageProxy }>[];
  attachmentDocuments: PDFDocumentProxy[];
  attachmentLabels: Map<string, string>;
}> => {
  const documentPages: Promise<{
    id: string;
    proxy: PDFPageProxy;
  }>[] = [];
  const attachmentDocuments: PDFDocumentProxy[] = [];
  const attachmentLabels = new Map<string, string>();

  let pageCounter = 1;
  let attIndex = 1;
  for (const att of pdfAttachments) {
    const attDoc = await getDocument({
      data: att.content,
      enableXfa: true,
    }).promise;
    attachmentDocuments.push(attDoc);

    const firstPageId = getPageId(instanceId, pageCounter);
    attachmentLabels.set(firstPageId, `${attIndex}. ${att.filename}`);

    for (let i = 1; i <= attDoc.numPages; i++) {
      const pageId = getPageId(instanceId, pageCounter);
      documentPages.push(
        attDoc.getPage(i).then((proxy) => ({ id: pageId, proxy })),
      );
      pageCounter++;
    }
    attIndex++;
  }

  return { documentPages, attachmentDocuments, attachmentLabels };
};

type LoadPDFProps = {
  fileId: string;
  buffer: ArrayBuffer;
  password?: string | undefined;
};

/**
 * Load and parse a PDF from an ArrayBuffer. Each call
 * creates a new document instance; the caller (provider)
 * is responsible for caching and cleanup.
 */

export const loadPDF = async ({
  fileId,
  buffer,
  password,
}: LoadPDFProps): Promise<Result<PDFDocument, PDFViewerError>> => {
  const loadingTask = getDocument({
    data: buffer.slice(0),
    enableXfa: true,
    ...(password && { password }),
  });

  const documentResult = await Result.tryPromise({
    try: async () => await loadingTask.promise,
    catch: (error) => {
      const passwordException = parsePasswordException(error);

      if (passwordException) {
        return new PDFViewerError({
          code: passwordException.code,
          message: passwordException.message,
          cause: error,
        });
      }

      return new PDFViewerError({
        code: "LOAD_FAILED",
        message: error instanceof Error ? error.message : "Failed to load PDF",
        cause: error,
      });
    },
  });

  if (Result.isError(documentResult)) {
    return Result.err(documentResult.error);
  }

  const document = documentResult.value;
  const attachmentDocuments: PDFDocumentProxy[] = [];

  return Result.tryPromise({
    try: async () => {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-assignment: pdfjs-dist types getAttachments() as Promise<any>
      const attachments = await document.getAttachments();
      const pdfAttachments =
        // oxlint-disable-next-line typescript-eslint/no-unsafe-argument: attachments is typed as any by pdfjs-dist
        parseAttachments(attachments);

      const isPortfolio = pdfAttachments.length > 0 && document.numPages <= 1;

      let documentPages: Promise<{ id: string; proxy: PDFPageProxy }>[] = [];
      let attachmentLabels: Map<string, string> = new Map<string, string>();

      if (isPortfolio) {
        const portfolio = await loadPortfolioPages(fileId, pdfAttachments);
        documentPages = portfolio.documentPages;
        attachmentDocuments.push(...portfolio.attachmentDocuments);
        attachmentLabels = portfolio.attachmentLabels;
      } else {
        for (let i = 1; i <= document.numPages; i++) {
          const pageId = getPageId(fileId, i);
          documentPages.push(
            document.getPage(i).then((proxy) => ({ id: pageId, proxy })),
          );
        }
      }

      const pagesResult = await Promise.all(documentPages);

      const firstPage = pagesResult.at(0);

      if (!firstPage) {
        await destroyPDFDocument({ document, attachmentDocuments });
        return Result.err(
          new PDFViewerError({
            code: "NO_RENDERABLE_PAGES",
            message: "PDF has no renderable pages",
          }),
        );
      }

      let isXfa = false;
      if (!isPortfolio) {
        const xfaHtml = await firstPage.proxy.getXfa().catch(() => null);
        isXfa = xfaHtml !== null;
      }

      const firstPageViewport = firstPage.proxy.getViewport({ scale: 1 });
      const baseScale = DEFAULT_PDF_WIDTH / firstPageViewport.width;

      const pages = new Map<string, PageInfo>(
        pagesResult.map((page) => {
          const initialViewport = page.proxy.getViewport({ scale: 1 });
          const viewport = page.proxy.getViewport({
            scale: baseScale,
          });

          return [
            page.id,
            {
              proxy: page.proxy,
              originalWidth: initialViewport.width,
              originalHeight: initialViewport.height,
              viewport,
            },
          ];
        }),
      );

      return Result.ok({
        document,
        attachmentDocuments,
        pages,
        attachmentLabels,
        isXfa,
        baseScale,
        toJSON: () => ({
          attachmentCount: attachmentDocuments.length,
          attachmentLabelCount: attachmentLabels.size,
          baseScale,
          isXfa,
          pageCount: pages.size,
        }),
      });
    },
    catch: async (error) => {
      await destroyPDFDocument({ document, attachmentDocuments });
      return new PDFViewerError({
        code: "LOAD_FAILED",
        message: error instanceof Error ? error.message : "Failed to load PDF",
        cause: error,
      });
    },
  }).then(Result.flatten);
};

export const destroyPDFDocument = async (data: {
  document: PDFDocumentProxy;
  attachmentDocuments: PDFDocumentProxy[];
}) => {
  await Promise.all([
    data.document.destroy(),
    ...data.attachmentDocuments.map(async (d) => await d.destroy()),
  ]);
};
