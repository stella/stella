import { queryOptions } from "@tanstack/react-query";

import type { ReaderAnnotationTargetType } from "@stll/api-contract/legal-reader-annotations";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

export type ReaderAnnotationsKey = {
  activeOrganizationId: string;
  targetId: string;
  targetType: ReaderAnnotationTargetType;
};

type AnnotationPage<T> = {
  items: readonly T[];
  nextCursor: string | null;
};

type FetchAnnotationPage<T> = (
  cursor: string | undefined,
) => Promise<AnnotationPage<T>>;

export const collectAnnotationPages = async <T>(
  fetchPage: FetchAnnotationPage<T>,
): Promise<T[]> => {
  const items: T[] = [];
  const collectPage = async (cursor: string | undefined): Promise<T[]> => {
    const page = await fetchPage(cursor);
    items.push(...page.items);

    return page.nextCursor === null ? items : collectPage(page.nextCursor);
  };

  return collectPage(undefined);
};

const ANNOTATIONS_PAGE_SIZE = 100;

export const readerAnnotationKeys = {
  all: ["legal-reader", "annotations"],
  forTarget: ({
    activeOrganizationId,
    targetId,
    targetType,
  }: ReaderAnnotationsKey) => [
    ...readerAnnotationKeys.all,
    { activeOrganizationId, targetId, targetType },
  ],
};

/**
 * The reader's own marks on one document and what colleagues shared. Keyed by
 * organization as well as document: the same decision or statute carries
 * different notes in each organization the reader belongs to.
 */
export const readerAnnotationsOptions = (key: ReaderAnnotationsKey) =>
  queryOptions({
    queryKey: readerAnnotationKeys.forTarget(key),
    queryFn: async ({ signal }) => {
      const annotations = await collectAnnotationPages(async (cursor) => {
        const response = await api.reader.annotations.get({
          query: {
            limit: ANNOTATIONS_PAGE_SIZE,
            targetId: key.targetId,
            targetType: key.targetType,
            ...(cursor === undefined ? {} : { cursor }),
          },
          fetch: { signal },
        });
        return unwrapEden(response);
      });
      return annotations;
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type ReaderAnnotation = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof readerAnnotationsOptions>["queryFn"]>
  >
>[number];
