import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import type { SelectionAnchor } from "@/features/case-law/annotations/selection-anchor";
import {
  decisionAnnotationKeys,
  decisionAnnotationsOptions,
} from "@/features/case-law/queries/annotations";
import type { DecisionAnnotation } from "@/features/case-law/queries/annotations";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

export type AnnotationColor = "yellow" | "green" | "sky" | "violet" | "red";
export type AnnotationStyle =
  | "highlight"
  | "underline"
  | "squiggly"
  | "strikethrough";
export type AnnotationVisibility = "private" | "shared";

export const ANNOTATION_COLORS: readonly AnnotationColor[] = [
  "yellow",
  "green",
  "sky",
  "violet",
  "red",
];

export const ANNOTATION_STYLES: readonly AnnotationStyle[] = [
  "highlight",
  "underline",
  "squiggly",
  "strikethrough",
];

export type CreateAnnotationInput = { spans: SelectionAnchor[] } & (
  | {
      kind: "highlight";
      color: AnnotationColor;
      style: AnnotationStyle;
      visibility: AnnotationVisibility;
    }
  | { kind: "comment"; body: string; visibility: AnnotationVisibility }
);

/** One named change to one annotation. */
export type UpdateAnnotationInput = { id: string } & (
  | { change: "body"; body: string }
  | { change: "color"; color: AnnotationColor }
  | { change: "style"; style: AnnotationStyle }
  | { change: "visibility"; visibility: AnnotationVisibility }
);

/** A mark not yet acknowledged by the server, keyed so it can be told apart. */
const PENDING_ID_PREFIX = "pending:";

/** A mark the server has not stored yet cannot be changed or removed. */
export const isPendingAnnotationId = (id: string): boolean =>
  id.startsWith(PENDING_ID_PREFIX);

/** Tells pending marks apart within one page; only ever advanced on a click. */
let pendingSequence = 0;

/**
 * The rows a new mark will have once stored, so the text shows it the moment
 * the reader picks a colour. One row per paragraph, under one group when
 * there are several, as the server lays them out.
 */
const pendingRows = ({
  author,
  input,
  stamp,
}: {
  author: { id: string; image: string | null; name: string | null };
  input: CreateAnnotationInput;
  stamp: number;
}): DecisionAnnotation[] => {
  const groupId =
    input.spans.length > 1 ? `${PENDING_ID_PREFIX}${stamp}` : null;
  const now = new Date();
  return input.spans.map((span, index) => ({
    authorId: author.id,
    authorImage: author.image,
    authorName: author.name ?? "",
    blockAnchorId: span.blockAnchorId,
    body: input.kind === "comment" && index === 0 ? input.body : null,
    color: input.kind === "highlight" ? input.color : null,
    createdAt: now,
    endOffset: span.endOffset,
    groupId,
    id: toSafeId<"caseLawDecisionAnnotation">(
      `${PENDING_ID_PREFIX}${stamp}:${index}`,
    ),
    kind: input.kind,
    mine: true,
    quote: span.quote,
    startOffset: span.startOffset,
    style: input.kind === "highlight" ? input.style : null,
    updatedAt: now,
    visibility: input.visibility,
  }));
};

/** The rows one change reaches: the whole group of the named row. */
const rowsOfSame = (
  rows: readonly DecisionAnnotation[],
  id: string,
): ((row: DecisionAnnotation) => boolean) => {
  const target = rows.find((row) => row.id === id);
  return (row) =>
    row.id === id ||
    (target?.groupId !== null &&
      target !== undefined &&
      row.groupId === target.groupId);
};

const applyChange = (
  row: DecisionAnnotation,
  change: UpdateAnnotationInput,
): DecisionAnnotation => {
  switch (change.change) {
    case "body": {
      return row.body === null ? row : { ...row, body: change.body };
    }
    case "color": {
      return { ...row, color: change.color };
    }
    case "style": {
      return { ...row, style: change.style };
    }
    case "visibility": {
      return { ...row, visibility: change.visibility };
    }
    default: {
      const unreachable: never = change;
      return unreachable;
    }
  }
};

/**
 * The reader's marks on a decision, with the three ways to change them.
 * Every change lands in the cache at once so the text answers the reader's
 * hand, then the list is refetched: the server is the one that knows what a
 * colleague shared meanwhile, and a rejected change is rolled back.
 */
export const useDecisionAnnotations = (
  decisionId: SafeId<"caseLawDecision">,
) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const {
    activeOrganizationId,
    id: userId,
    image,
    name,
  } = useAuthenticatedUser();
  const key = { activeOrganizationId, decisionId };
  const queryKey = decisionAnnotationKeys.forDecision(key);
  const { data } = useQuery(decisionAnnotationsOptions(key));

  const patchCache = async (
    patch: (rows: readonly DecisionAnnotation[]) => DecisionAnnotation[],
  ): Promise<{ previous: DecisionAnnotation[] | undefined }> => {
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData<DecisionAnnotation[]>(queryKey);
    queryClient.setQueryData<DecisionAnnotation[]>(queryKey, (rows) =>
      patch(rows === undefined ? [] : rows),
    );
    return { previous };
  };

  const settle = {
    onError: (
      error: unknown,
      _input: unknown,
      context: { previous: DecisionAnnotation[] | undefined } | undefined,
    ) => {
      if (context !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  };

  const create = useMutation({
    mutationFn: async (input: CreateAnnotationInput) => {
      const response = await api.case
        .decisions({ decisionId })
        .annotations.post(input);
      return unwrapEden(response);
    },
    onMutate: async (input) => {
      pendingSequence += 1;
      const stamp = pendingSequence;
      return await patchCache((rows) => [
        ...rows,
        ...pendingRows({
          author: { id: userId, image: image ?? null, name: name ?? null },
          input,
          stamp,
        }),
      ]);
    },
    ...settle,
  });

  const update = useMutation({
    mutationFn: async ({ id, ...change }: UpdateAnnotationInput) => {
      const response = await api.case
        .annotations({
          annotationId: toSafeId<"caseLawDecisionAnnotation">(id),
        })
        .patch(change);
      return unwrapEden(response);
    },
    onMutate: async (input) =>
      await patchCache((rows) => {
        const touched = rowsOfSame(rows, input.id);
        return rows.map((row) =>
          touched(row) ? applyChange(row, input) : row,
        );
      }),
    ...settle,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.case
        .annotations({
          annotationId: toSafeId<"caseLawDecisionAnnotation">(id),
        })
        .delete();
      return unwrapEden(response);
    },
    onMutate: async (id) =>
      await patchCache((rows) => {
        const touched = rowsOfSame(rows, id);
        return rows.filter((row) => !touched(row));
      }),
    ...settle,
  });

  const annotations: readonly DecisionAnnotation[] =
    data === undefined ? [] : data;

  return { annotations, create, remove, update };
};
