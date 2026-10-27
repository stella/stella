import { queryOptions, skipToken } from "@tanstack/react-query";

import { sha256Hex } from "@stll/sha256/browser";

import { collectAnnotationPages } from "@/components/legal-reader/annotations/reader-annotations-query";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import type { NumberedPageSearchText } from "@/lib/pdf/pdf-search";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

export type DocumentAnnotationsKey = {
  entityId: string;
  /** The file the viewer shows; marks on its other versions come along. */
  fieldId: string;
  /** Who reads: private marks are the author's alone. */
  viewer: { organizationId: string; userId: string };
  workspaceId: string;
};

export const documentAnnotationKeys = {
  all: (workspaceId: string) =>
    ["documents", workspaceId, "annotations"] as const,
  /** A file's page texts; its bytes never change under its id. */
  markPages: (fileId: string | null, pageNumbers: readonly number[]) =>
    [
      "documents",
      "mark-pages",
      fileId,
      [...new Set(pageNumbers)].toSorted((a, b) => a - b),
    ] as const,
  forFile: ({
    entityId,
    fieldId,
    viewer,
    workspaceId,
  }: DocumentAnnotationsKey) =>
    [
      ...documentAnnotationKeys.all(workspaceId),
      {
        entityId,
        fieldId,
        organizationId: viewer.organizationId,
        userId: viewer.userId,
      },
    ] as const,
};

const ANNOTATIONS_PAGE_SIZE = 100;

/**
 * The marks on one matter document's PDF the reader can see: their own and
 * what colleagues on the matter shared, including those placed on the same
 * file of another version, each naming where it was placed.
 */
export const documentAnnotationsOptions = (key: DocumentAnnotationsKey) =>
  queryOptions({
    queryKey: documentAnnotationKeys.forFile(key),
    queryFn: async ({ signal }) =>
      await collectAnnotationPages(async (cursor) => {
        const page = await api
          .entities({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
          .entity({ entityId: toSafeId<"entity">(key.entityId) })
          .field({ fieldId: toSafeId<"field">(key.fieldId) })
          .annotations.get({
            query: {
              limit: ANNOTATIONS_PAGE_SIZE,
              ...(cursor === undefined ? {} : { cursor }),
            },
            fetch: { signal },
          });
        return unwrapApiResponse(page);
      }),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type DocumentAnnotation = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof documentAnnotationsOptions>["queryFn"]>
  >
>[number];

/** A page's text as the server reads it, and the digest a mark keeps of it. */
export type DocumentMarkPage = NumberedPageSearchText & { sha256: string };

type MarkedFile = { buffer: ArrayBuffer; fileId: string };

type DocumentMarkPagesArgs = {
  /** The displayed PDF; undefined while it loads. */
  file: MarkedFile | undefined;
  pageNumbers: readonly number[];
};

/**
 * The texts of the given pages, read off the main thread with the extractor
 * the server uses, so a mark's offsets index the same units here, with each
 * page's digest to tell whether a mark's offsets still point at its words.
 */
const readMarkPages = async ({
  bytes,
  pageNumbers,
  signal,
}: {
  bytes: ArrayBuffer;
  pageNumbers: readonly number[];
  signal: AbortSignal;
}): Promise<ReadonlyMap<number, DocumentMarkPage>> => {
  const { extractPDFPageSearchTextsInWorker } =
    await import("@/lib/pdf/pdf-page-text-worker-client");
  const pages = await extractPDFPageSearchTextsInWorker({
    bytes,
    pageNumbers,
    signal,
  });
  const withDigests = await Promise.all(
    pages.map(async (page): Promise<DocumentMarkPage> => ({
      ...page,
      sha256: await sha256Hex(page.text),
    })),
  );
  return new Map(withDigests.map((page) => [page.pageNumber, page] as const));
};

export const documentMarkPagesOptions = ({
  file,
  pageNumbers,
}: DocumentMarkPagesArgs) =>
  queryOptions({
    queryKey: documentAnnotationKeys.markPages(
      file?.fileId ?? null,
      pageNumbers,
    ),
    queryFn:
      file === undefined || pageNumbers.length === 0
        ? skipToken
        : async ({ signal }) =>
            await readMarkPages({
              // The worker takes the bytes it is sent; the viewer keeps its own.
              bytes: file.buffer.slice(0),
              pageNumbers,
              signal,
            }),
    staleTime: Number.POSITIVE_INFINITY,
  });

/** The same read for pages a selection covers, which always runs. */
export const selectedMarkPagesOptions = ({
  file,
  pageNumbers,
}: {
  file: MarkedFile;
  pageNumbers: readonly number[];
}) =>
  queryOptions({
    queryKey: documentAnnotationKeys.markPages(file.fileId, pageNumbers),
    queryFn: async ({ signal }) =>
      await readMarkPages({
        // The worker takes the bytes it is sent; the viewer keeps its own.
        bytes: file.buffer.slice(0),
        pageNumbers,
        signal,
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
