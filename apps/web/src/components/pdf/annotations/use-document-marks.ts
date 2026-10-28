import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { placeMark } from "@stll/api-contract/pdf-mark-placement";
import type { MarkPlacement } from "@stll/api-contract/pdf-mark-placement";
import { Temporal } from "@stll/time";

import type {
  AnnotationColor,
  AnnotationStyle,
  AnnotationVisibility,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import {
  pendingMarkIds,
  useOptimisticMarkMutations,
} from "@/components/legal-reader/annotations/use-optimistic-annotation-mutations";
import {
  documentAnnotationsOptions,
  documentMarkPagesOptions,
  selectedMarkPagesOptions,
} from "@/components/pdf/annotations/document-annotations-query";
import type { DocumentAnnotation } from "@/components/pdf/annotations/document-annotations-query";
import {
  locateSelection,
  SELECTION_REFUSAL,
} from "@/components/pdf/annotations/document-mark-anchor.logic";
import type {
  LocatedSelection,
  LocatedSpan,
  SelectedLayerText,
} from "@/components/pdf/annotations/document-mark-anchor.logic";
import { api } from "@/lib/api";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapApiResponse } from "@/lib/errors/api";
import type { PDFPageSource } from "@/lib/pdf/pdf-page-source";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";

/** A mark with where it sits on the file the viewer shows. */
export type DocumentMark = DocumentAnnotation & { placement: MarkPlacement };

/** One page's share of a new mark, with the digest of the page it is on. */
export type PlacedSpan = LocatedSpan & { pageTextSha256: string };

type CreateDocumentMarkInput = {
  spans: PlacedSpan[];
  visibility: AnnotationVisibility;
} & (
  | { kind: "highlight"; color: AnnotationColor; style: AnnotationStyle }
  | { kind: "comment"; body: string }
);

type DocumentMarkLocation =
  | { type: "located"; spans: PlacedSpan[] }
  | Extract<LocatedSelection, { type: "refused" }>;

export type DocumentMarks = {
  /**
   * False outside a signed-in session, without a document to mark, or while
   * the viewer shows anything but the file's own pages.
   */
  available: boolean;
  /** Every mark, in reading order: by page, then by place on the page. */
  marks: DocumentMark[];
  create: (input: CreateDocumentMarkInput) => Promise<unknown>;
  update: (change: UpdateAnnotationInput) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  /** Anchors a selection's pages in the text the server will check. */
  locate: (
    layers: readonly SelectedLayerText[],
  ) => Promise<DocumentMarkLocation>;
};

type DocumentMarksScope = {
  entityId: string;
  /** The displayed PDF; undefined while it loads. */
  file: { buffer: ArrayBuffer; fileId: string } | undefined;
  fieldId: string;
  /**
   * Whose pages the viewer shows; undefined while it loads. A portfolio shows
   * the PDFs it attaches, which the file's page texts do not cover, so a mark
   * could be neither placed nor anchored there.
   */
  pageSource: PDFPageSource | undefined;
  workspaceId: string;
};

const readingOrder = (a: DocumentMark, b: DocumentMark) =>
  a.pageNumber - b.pageNumber || a.startOffset - b.startOffset;

/**
 * The marks on one matter document's PDF and the reader's ways to change
 * them, with the same optimistic writes, rollback and toast as the case-law
 * reader's marks. Each mark is placed on the file the viewer shows from the
 * page texts read off the main thread.
 */
export const useDocumentMarks = ({
  entityId,
  fieldId,
  file,
  pageSource,
  workspaceId,
}: DocumentMarksScope): DocumentMarks => {
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const options = documentAnnotationsOptions({
    entityId,
    fieldId,
    viewer: {
      organizationId: user?.activeOrganizationId ?? "",
      userId: user?.id ?? "",
    },
    workspaceId,
  });
  const available =
    user !== null && entityId !== "" && pageSource === "document";
  const view = queryView(useQuery({ ...options, enabled: available }));
  useQueryViewError(view, "useDocumentMarks:query");
  const rows = available && view.type === "items" ? view.items : [];

  const pagesOptions = documentMarkPagesOptions({
    file,
    pageNumbers: [...new Set(rows.map((row) => row.pageNumber))],
  });
  const pagesView = queryView(useQuery(pagesOptions));
  useQueryViewError(pagesView, "useDocumentMarks:pages");
  const pages = pagesView.type === "items" ? pagesView.items : undefined;

  const marks = rows
    .map((row): DocumentMark => ({
      ...row,
      placement: placeMark({
        anchor: row,
        page: pages?.get(row.pageNumber),
        pagesRead: pages !== undefined,
        viewedFieldId: fieldId,
      }),
    }))
    .toSorted(readingOrder);

  const routes = () =>
    api
      .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .entity({ entityId: toSafeId<"entity">(entityId) });
  const oneMark = (id: string) =>
    routes().annotations({
      annotationId: toSafeId<"legalReaderAnnotation">(id),
    });

  const { create, remove, update } = useOptimisticMarkMutations({
    handlerId: "document-annotations",
    queryKey: options.queryKey,
    create: async ({ spans, ...input }: CreateDocumentMarkInput) =>
      unwrapApiResponse(
        await routes()
          .field({ fieldId: toSafeId<"field">(fieldId) })
          .annotations.post({
            ...input,
            spans: spans.map(
              ({ endOffset, pageNumber, quote, startOffset }) => ({
                endOffset,
                pageNumber,
                quote,
                startOffset,
              }),
            ),
          }),
      ),
    pendingRows: ({ author, input, stamp }): DocumentAnnotation[] => {
      const { groupId, rowId } = pendingMarkIds(stamp, input.spans.length);
      const now = Temporal.Now.instant().toString();
      // The mark is on the file being read, whose version the other marks
      // on it already name.
      const versionNumber =
        rows.find((row) => row.fieldId === fieldId)?.versionNumber ?? 0;
      return input.spans.map((span, index) => ({
        authorId: author.id,
        authorImage: author.image,
        authorName: author.name ?? "",
        body: input.kind === "comment" && index === 0 ? input.body : null,
        color: input.kind === "highlight" ? input.color : null,
        createdAt: now,
        endOffset: span.endOffset,
        fieldId,
        groupId,
        id: rowId(index),
        kind: input.kind,
        mine: true,
        pageNumber: span.pageNumber,
        pageTextSha256: span.pageTextSha256,
        quote: span.quote,
        startOffset: span.startOffset,
        style: input.kind === "highlight" ? input.style : null,
        updatedAt: now,
        versionNumber,
        visibility: input.visibility,
      }));
    },
    remove: async (id: string) => unwrapApiResponse(await oneMark(id).delete()),
    update: async ({ id, ...change }: UpdateAnnotationInput) =>
      unwrapApiResponse(await oneMark(id).patch(change)),
  });

  const locate = async (
    layers: readonly SelectedLayerText[],
  ): Promise<DocumentMarkLocation> => {
    const first = layers.at(0);
    if (file === undefined || first === undefined) {
      return {
        type: "refused",
        reason: SELECTION_REFUSAL.noText,
        pageNumber: first?.pageNumber ?? 1,
      };
    }
    const selectedPages = await queryClient.query(
      selectedMarkPagesOptions({
        file,
        pageNumbers: layers.map((layer) => layer.pageNumber),
      }),
    );
    const located = locateSelection({ layers, pages: selectedPages });
    if (located.type === "refused") {
      return located;
    }
    return {
      type: "located",
      spans: located.spans.map((span) => ({
        ...span,
        pageTextSha256:
          selectedPages.get(span.pageNumber)?.sha256 ??
          panic("A located span lost its page"),
      })),
    };
  };

  return {
    available,
    marks,
    create,
    locate,
    remove,
    update,
  };
};
