import { Result } from "better-result";
import type * as PDFJS from "pdfjs-dist";

import { DEFAULT_PDF_WIDTH } from "@/lib/pdf/consts";
import { parseAttachments } from "@/lib/pdf/parse-attachments";
import type { PDFAttachment } from "@/lib/pdf/parse-attachments";
import type { PageInfo } from "@/lib/pdf/pdf-context";
import { PDFViewerError } from "@/lib/pdf/pdf-errors";
import type { PDFViewerCode } from "@/lib/pdf/pdf-errors";
import { loadPdfjs } from "@/lib/pdf/pdfjs-loader";
import type {
  PDFDocumentLoadingTask,
  PDFPageProxy,
} from "@/lib/pdf/pdfjs-loader";
import { getPageId } from "@/lib/pdf/utils";

type PasswordResponses = typeof PDFJS.PasswordResponses;

export type PDFDocument = {
  loadingTask: PDFDocumentLoadingTask;
  attachmentLoadingTasks: PDFDocumentLoadingTask[];
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
  passwordResponses: PasswordResponses | null,
): { code: PDFViewerCode; message: string } | null => {
  if (!isPasswordException(error) || passwordResponses === null) {
    return null;
  }

  return {
    code:
      error.code === passwordResponses.INCORRECT_PASSWORD
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
  attachmentLoadingTasks: PDFDocumentLoadingTask[];
  attachmentLabels: Map<string, string>;
}> => {
  const { getDocument } = await loadPdfjs();
  const documentPages: Promise<{
    id: string;
    proxy: PDFPageProxy;
  }>[] = [];
  const attachmentLoadingTasks: PDFDocumentLoadingTask[] = [];
  const attachmentLabels = new Map<string, string>();

  let pageCounter = 1;
  let attIndex = 1;
  for (const att of pdfAttachments) {
    const attLoadingTask = getDocument({
      data: att.content,
      enableXfa: true,
    });
    const attDoc = await attLoadingTask.promise;
    attachmentLoadingTasks.push(attLoadingTask);

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

  return { documentPages, attachmentLoadingTasks, attachmentLabels };
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
  let passwordResponses: PasswordResponses | null = null;

  const documentResult = await Result.tryPromise({
    try: async () => {
      const { getDocument, PasswordResponses } = await loadPdfjs();
      passwordResponses = PasswordResponses;
      const loadingTask = getDocument({
        data: buffer.slice(0),
        enableXfa: true,
        ...(password && { password }),
      });

      const document = await loadingTask.promise;
      return { loadingTask, document };
    },
    catch: (error) => {
      const passwordException = parsePasswordException(
        error,
        passwordResponses,
      );

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

  const { loadingTask, document } = documentResult.value;
  const attachmentLoadingTasks: PDFDocumentLoadingTask[] = [];

  return Result.tryPromise({
    try: async () => {
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- pdfjs-dist types getAttachments() as Promise<any>
      const attachments = await document.getAttachments();
      const pdfAttachments =
        // oxlint-disable-next-line typescript/no-unsafe-argument -- attachments is typed as any by pdfjs-dist
        parseAttachments(attachments);

      const isPortfolio = pdfAttachments.length > 0 && document.numPages <= 1;

      let documentPages: Promise<{ id: string; proxy: PDFPageProxy }>[] = [];
      let attachmentLabels: Map<string, string> = new Map<string, string>();

      if (isPortfolio) {
        const portfolio = await loadPortfolioPages(fileId, pdfAttachments);
        documentPages = portfolio.documentPages;
        attachmentLoadingTasks.push(...portfolio.attachmentLoadingTasks);
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
        await destroyPDFDocument({ loadingTask, attachmentLoadingTasks });
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
        loadingTask,
        attachmentLoadingTasks,
        pages,
        attachmentLabels,
        isXfa,
        baseScale,
        toJSON: () => ({
          attachmentCount: attachmentLoadingTasks.length,
          attachmentLabelCount: attachmentLabels.size,
          baseScale,
          isXfa,
          pageCount: pages.size,
        }),
      });
    },
    catch: async (error) => {
      await destroyPDFDocument({ loadingTask, attachmentLoadingTasks });
      return new PDFViewerError({
        code: "LOAD_FAILED",
        message: error instanceof Error ? error.message : "Failed to load PDF",
        cause: error,
      });
    },
  }).then(Result.flatten);
};

export const destroyPDFDocument = async (data: {
  loadingTask: PDFDocumentLoadingTask;
  attachmentLoadingTasks: PDFDocumentLoadingTask[];
}) => {
  await Promise.all([
    data.loadingTask.destroy(),
    ...data.attachmentLoadingTasks.map(async (task) => await task.destroy()),
  ]);
};
