import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Result } from "better-result";

import { STALE_TIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { readQueryResult } from "@/lib/errors/query-result";
import { destroyPDFDocument } from "@/lib/pdf/pdf-cleanup";
import type { PDFViewerError } from "@/lib/pdf/pdf-errors";
import type { PDFDocument } from "@/lib/pdf/pdf-loader";
import { loadPDF } from "@/lib/pdf/pdf-loader";
import type { QueryOptionsInput } from "@/lib/react-query";

type PDFDocumentPageKey = {
  fileId: string;
};

type PDFDocumentCacheKey = PDFDocumentPageKey & {
  bufferId: number;
};

type PDFDocumentQueryData = Result<PDFDocument, PDFViewerError>;

const pdfDocumentKeys = {
  all: () => ["pdf-document"] as const,
  byFile: ({ fileId, bufferId }: PDFDocumentCacheKey) =>
    [...pdfDocumentKeys.all(), fileId, bufferId] as const,
};

// A parsed document belongs to the bytes it was parsed from: a new version
// of the same file field (or a refetch through a fresh URL) arrives as a new
// buffer and must not reuse the old document.
const bufferIds = new WeakMap<ArrayBuffer, number>();
let nextBufferId = 0;

const bufferIdentity = (buffer: ArrayBuffer): number => {
  const known = bufferIds.get(buffer);
  if (known !== undefined) {
    return known;
  }
  const id = nextBufferId;
  nextBufferId += 1;
  bufferIds.set(buffer, id);
  return id;
};

const isPasswordError = ({ code }: PDFViewerError): boolean =>
  code === "PASSWORD_REQUIRED" || code === "INCORRECT_PASSWORD";

const isPDFDocumentQueryKey = (
  queryKey: unknown,
): queryKey is ReturnType<typeof pdfDocumentKeys.byFile> => {
  const [scope] = pdfDocumentKeys.all();
  return Array.isArray(queryKey) && queryKey[0] === scope;
};

const cleanupInstalledClients = new WeakSet<QueryClient>();

export const installPDFDocumentCleanup = (queryClient: QueryClient) => {
  if (cleanupInstalledClients.has(queryClient)) {
    return;
  }

  cleanupInstalledClients.add(queryClient);

  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "removed" ||
      !isPDFDocumentQueryKey(event.query.queryKey)
    ) {
      return;
    }

    const rawData: unknown = event.query.state.data;

    if (rawData === undefined || rawData === null) {
      return;
    }
    if (!isCachedPDFDocument(rawData)) {
      return;
    }

    detached(
      destroyPDFDocument(rawData.value),
      "use-pdf-document.destroy-pdf-document",
    );
  });
};

const isDestroyable = (
  value: unknown,
): value is { destroy: () => Promise<void> } =>
  typeof value === "object" &&
  value !== null &&
  "destroy" in value &&
  typeof value.destroy === "function";

const isCachedPDFDocument = (
  value: unknown,
): value is {
  status: "ok";
  value: {
    loadingTask: { destroy: () => Promise<void> };
    attachmentLoadingTasks: { destroy: () => Promise<void> }[];
  };
} => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    value.status !== "ok" ||
    !("value" in value) ||
    typeof value.value !== "object" ||
    value.value === null
  ) {
    return false;
  }
  const document = value.value;
  return (
    "loadingTask" in document &&
    isDestroyable(document.loadingTask) &&
    "attachmentLoadingTasks" in document &&
    Array.isArray(document.attachmentLoadingTasks) &&
    document.attachmentLoadingTasks.every(isDestroyable)
  );
};

type PDFDocumentOptionsInput = QueryOptionsInput<
  PDFDocumentPageKey,
  {
    buffer: ArrayBuffer;
    password?: string | undefined;
  }
>;

export const usePDFDocument = ({ key, context }: PDFDocumentOptionsInput) => {
  const queryClient = useQueryClient();
  const queryKey = pdfDocumentKeys.byFile({
    fileId: key.fileId,
    bufferId: bufferIdentity(context.buffer),
  });

  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- keyed by file and buffer identity; a password change removes the query manually.
  const { data } = useSuspenseQuery({
    structuralSharing: false,
    // the query should be only removed, if it's updated updated the document instance needs to be cleaned up manually
    staleTime: STALE_TIME.INFINITE,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey,
    // The viewer's error boundary owns retries: it resets this query and
    // remounts, which loads the document on a fresh PDF.js worker.
    retry: false,
    queryFn: async (): Promise<PDFDocumentQueryData> => {
      const result = await loadPDF({
        fileId: key.fileId,
        buffer: context.buffer,
        password: context.password,
      });
      // Only a password answer is cached as data (the viewer prompts for
      // it). Any other failure rejects the query, so it holds an error that
      // a boundary reset clears, never an infinitely fresh failed document.
      if (Result.isError(result) && !isPasswordError(result.error)) {
        return readQueryResult(Result.err(result.error));
      }
      return result;
    },
  });

  const refetch = () => {
    queryClient.removeQueries({ queryKey, exact: true });
  };

  return { data, refetch };
};
