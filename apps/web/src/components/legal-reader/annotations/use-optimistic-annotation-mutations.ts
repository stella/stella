import { useRef } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DataTag, QueryClient, QueryKey } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import { getAnalytics } from "@/lib/analytics/provider";
import { optionalArray } from "@/lib/arrays";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";

/** A mark not yet acknowledged by the server, keyed so it can be told apart. */
const PENDING_ID_PREFIX = "pending:";

/** A mark the server has not stored yet cannot be changed or removed. */
export const isPendingAnnotationId = (id: string): boolean =>
  id.startsWith(PENDING_ID_PREFIX);

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
}): ReaderAnnotation[] => {
  const groupId =
    input.spans.length > 1 ? `${PENDING_ID_PREFIX}${stamp}` : null;
  const now = Temporal.Now.instant().toString();
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
    id: toSafeId<"legalReaderAnnotation">(
      `${PENDING_ID_PREFIX}${stamp}:${index}`,
    ),
    kind: input.kind,
    mine: true,
    quote: span.quote,
    quotePrefix: span.quotePrefix,
    quoteSuffix: span.quoteSuffix,
    startOffset: span.startOffset,
    style: input.kind === "highlight" ? input.style : null,
    updatedAt: now,
    visibility: input.visibility,
  }));
};

/** The rows one change reaches: the whole group of the named row. */
const rowsOfSame = (
  rows: readonly ReaderAnnotation[],
  id: string,
): ((row: ReaderAnnotation) => boolean) => {
  const target = rows.find((row) => row.id === id);
  return (row) =>
    row.id === id ||
    (target?.groupId !== null &&
      target !== undefined &&
      row.groupId === target.groupId);
};

const applyChange = (
  row: ReaderAnnotation,
  change: UpdateAnnotationInput,
): ReaderAnnotation => {
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
      change satisfies never;
      return panic(`Unhandled change: ${String(change)}`);
    }
  }
};

type OptimisticAnnotationRequests<TCreate, TCreated, TChange> = {
  handlerId: string;
  /** The cached rows the changes land in at once. */
  queryKey: DataTag<QueryKey, ReaderAnnotation[], Error>;
  /** Stores a new mark on the server. */
  create: (input: TCreate) => Promise<TCreated>;
  /** The mark a create request shows in the cache until the server answers. */
  pendingInput: (input: TCreate) => CreateAnnotationInput;
  /** Changes one mark (and the rest of its group) on the server. */
  update: (change: TChange) => Promise<unknown>;
  /** Deletes one mark (and the rest of its group) on the server. */
  remove: (id: string) => Promise<unknown>;
};

type OptimisticAnnotationMutations<TCreate, TCreated, TChange> = {
  create: (input: TCreate) => Promise<TCreated>;
  remove: (id: string) => Promise<unknown>;
  update: (change: TChange) => Promise<unknown>;
};

export const patchAnnotationCache = async (
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, ReaderAnnotation[], Error>,
  patch: (rows: readonly ReaderAnnotation[]) => ReaderAnnotation[],
): Promise<{ previous: ReaderAnnotation[] | undefined }> => {
  await queryClient.cancelQueries({ queryKey });
  const previous = queryClient.getQueryData(queryKey);
  if (previous !== undefined) {
    queryClient.setQueryData(queryKey, (rows) => patch(optionalArray(rows)));
  }
  return { previous };
};

/**
 * Creates, changes and removes signed-in marks the way every reader does:
 * each change lands in the cache at once, rolls back on failure, and is then
 * refetched, because the server knows what a colleague shared meanwhile.
 * Callers name only the routes the marks are stored through.
 */
export const useOptimisticAnnotationMutations = <
  TCreate,
  TCreated,
  TChange extends UpdateAnnotationInput,
>({
  create: createRequest,
  handlerId,
  pendingInput,
  queryKey,
  remove: removeRequest,
  update: updateRequest,
}: OptimisticAnnotationRequests<
  TCreate,
  TCreated,
  TChange
>): OptimisticAnnotationMutations<TCreate, TCreated, TChange> => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const pendingSequence = useRef(0);

  const patchCache = async (
    patch: (rows: readonly ReaderAnnotation[]) => ReaderAnnotation[],
  ): Promise<{ previous: ReaderAnnotation[] | undefined }> =>
    await patchAnnotationCache(queryClient, queryKey, patch);

  const settle = (operation: "create" | "update" | "delete") => ({
    onError: (
      error: unknown,
      _input: unknown,
      context: { previous: ReaderAnnotation[] | undefined } | undefined,
    ) => {
      if (context !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      getAnalytics().captureError(error, {
        fingerprintKey: "useOptimisticAnnotationMutations:failure",
        scope: { type: "handler", handlerId: `${handlerId}.${operation}` },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const create = useMutation({
    mutationFn: createRequest,
    onMutate: async (input: TCreate) => {
      // Tells pending marks apart within one reader; only ever advanced on a
      // submit, never while rendering.
      pendingSequence.current += 1;
      const stamp = pendingSequence.current;
      return await patchCache((rows) => [
        ...rows,
        ...pendingRows({
          author: {
            id: user?.id ?? "",
            image: user?.image ?? null,
            name: user?.name ?? null,
          },
          input: pendingInput(input),
          stamp,
        }),
      ]);
    },
    ...settle("create"),
  });

  const update = useMutation({
    mutationFn: updateRequest,
    onMutate: async (input: TChange) =>
      await patchCache((rows) => {
        const touched = rowsOfSame(rows, input.id);
        return rows.map((row) =>
          touched(row) ? applyChange(row, input) : row,
        );
      }),
    ...settle("update"),
  });

  const remove = useMutation({
    mutationFn: removeRequest,
    onMutate: async (id: string) =>
      await patchCache((rows) => {
        const touched = rowsOfSame(rows, id);
        return rows.filter((row) => !touched(row));
      }),
    ...settle("delete"),
  });

  return {
    create: create.mutateAsync,
    remove: remove.mutateAsync,
    update: update.mutateAsync,
  };
};
