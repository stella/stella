import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { Result } from "better-result";

import { STALE_TIME } from "@/lib/consts";
import { destroyPDFDocument } from "@/lib/pdf/pdf-cleanup";
import type { PDFViewerError } from "@/lib/pdf/pdf-errors";
import type { PDFDocument } from "@/lib/pdf/pdf-loader";
import { loadPDF } from "@/lib/pdf/pdf-loader";
import type { QueryOptionsInput } from "@/lib/react-query";

type PDFDocumentPageKey = {
  fileId: string;
};

type PDFDocumentQueryData = Result<PDFDocument, PDFViewerError>;

const pdfDocumentKeys = {
  all: () => ["pdf-document"] as const,
  byFileId: ({ fileId }: PDFDocumentPageKey) =>
    [...pdfDocumentKeys.all(), fileId] as const,
};

const isPDFDocumentQueryKey = (
  queryKey: unknown,
): queryKey is ReturnType<typeof pdfDocumentKeys.byFileId> => {
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

    void destroyPDFDocument(rawData.value);
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

  // eslint-disable-next-line @tanstack/query/exhaustive-deps -- this hook intentionally keys by file identity and uses manual query removal when the in-memory buffer or password changes.
  const { data } = useSuspenseQuery({
    structuralSharing: false,
    // the query should be only removed, if it's updated updated the document instance needs to be cleaned up manually
    staleTime: STALE_TIME.INFINITE,
    gcTime: STALE_TIME.FIVETEEN.MINUTES,
    queryKey: pdfDocumentKeys.byFileId(key),
    queryFn: async (): Promise<PDFDocumentQueryData> =>
      await loadPDF({
        fileId: key.fileId,
        buffer: context.buffer,
        password: context.password,
      }),
  });

  const refetch = () => {
    queryClient.removeQueries({
      queryKey: pdfDocumentKeys.byFileId({ fileId: key.fileId }),
      exact: true,
    });
  };

  return { data, refetch };
};
