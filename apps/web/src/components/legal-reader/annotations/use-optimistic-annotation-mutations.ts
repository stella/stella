import { useRef } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DataTag, QueryClient, QueryKey } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";

import type {
  AnnotationColor,
  AnnotationStyle,
  AnnotationVisibility,
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

/** Who a pending mark shows as written by: the signed-in reader. */
type PendingMarkAuthor = {
  id: string;
  image: string | null;
  name: string | null;
};

/** The ids a new mark's rows carry until the server answers. */
export const pendingMarkIds = (stamp: number, rowCount: number) => ({
  groupId: rowCount > 1 ? `${PENDING_ID_PREFIX}${stamp}` : null,
  rowId: (index: number) =>
    toSafeId<"legalReaderAnnotation">(`${PENDING_ID_PREFIX}${stamp}:${index}`),
});

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
  author: PendingMarkAuthor;
  input: CreateAnnotationInput;
  stamp: number;
}): ReaderAnnotation[] => {
  const { groupId, rowId } = pendingMarkIds(stamp, input.spans.length);
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
    id: rowId(index),
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

/** What every stored mark carries that a change reaches. */
type MarkRow = {
  id: string;
  groupId: string | null;
  body: string | null;
  color: AnnotationColor | null;
  style: AnnotationStyle | null;
  visibility: AnnotationVisibility;
  updatedAt: string;
};

/** The rows one change reaches: the whole group of the named row. */
const rowsOfSame = <TRow extends MarkRow>(
  rows: readonly TRow[],
  id: string,
): ((row: TRow) => boolean) => {
  const target = rows.find((row) => row.id === id);
  return (row) =>
    row.id === id ||
    (target?.groupId !== null &&
      target !== undefined &&
      row.groupId === target.groupId);
};

/** The row as the server will store it, `updatedAt` included. */
const applyChange = <TRow extends MarkRow>(
  row: TRow,
  change: UpdateAnnotationInput,
): TRow => {
  const updatedAt = Temporal.Now.instant().toString();
  switch (change.change) {
    case "body": {
      return row.body === null ? row : { ...row, body: change.body, updatedAt };
    }
    case "color": {
      return { ...row, color: change.color, updatedAt };
    }
    case "style": {
      return { ...row, style: change.style, updatedAt };
    }
    case "visibility": {
      return { ...row, visibility: change.visibility, updatedAt };
    }
    default: {
      change satisfies never;
      return panic(`Unhandled change: ${String(change)}`);
    }
  }
};

type OptimisticMarkRequests<TCreate, TCreated, TChange, TRow> = {
  handlerId: string;
  /** The cached rows the changes land in at once. */
  queryKey: DataTag<QueryKey, TRow[], Error>;
  /** Stores a new mark on the server. */
  create: (input: TCreate) => Promise<TCreated>;
  /** The rows a create request shows in the cache until the server answers. */
  pendingRows: (pending: {
    author: PendingMarkAuthor;
    input: TCreate;
    stamp: number;
  }) => TRow[];
  /** Changes one mark (and the rest of its group) on the server. */
  update: (change: TChange) => Promise<unknown>;
  /** Deletes one mark (and the rest of its group) on the server. */
  remove: (id: string) => Promise<unknown>;
};

type OptimisticAnnotationRequests<TCreate, TCreated, TChange> = Omit<
  OptimisticMarkRequests<TCreate, TCreated, TChange, ReaderAnnotation>,
  "pendingRows"
> & {
  /** The mark a create request shows in the cache until the server answers. */
  pendingInput: (input: TCreate) => CreateAnnotationInput;
};

type OptimisticAnnotationMutations<TCreate, TCreated, TChange> = {
  create: (input: TCreate) => Promise<TCreated>;
  remove: (id: string) => Promise<unknown>;
  update: (change: TChange) => Promise<unknown>;
};

export const patchAnnotationCache = async <TRow>(
  queryClient: QueryClient,
  queryKey: DataTag<QueryKey, TRow[], Error>,
  patch: (rows: readonly TRow[]) => TRow[],
): Promise<{ previous: TRow[] | undefined }> => {
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
 * Callers name only the routes the marks are stored through and the rows a
 * new mark shows as.
 */
export const useOptimisticMarkMutations = <
  TCreate,
  TCreated,
  TChange extends UpdateAnnotationInput,
  TRow extends MarkRow,
>({
  create: createRequest,
  handlerId,
  pendingRows: pendingRowsOf,
  queryKey,
  remove: removeRequest,
  update: updateRequest,
}: OptimisticMarkRequests<
  TCreate,
  TCreated,
  TChange,
  TRow
>): OptimisticAnnotationMutations<TCreate, TCreated, TChange> => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const pendingSequence = useRef(0);

  const patchCache = async (
    patch: (rows: readonly TRow[]) => TRow[],
  ): Promise<{ previous: TRow[] | undefined }> =>
    await patchAnnotationCache(queryClient, queryKey, patch);

  const settle = (operation: "create" | "update" | "delete") => ({
    onError: (
      error: unknown,
      _input: unknown,
      context: { previous: TRow[] | undefined } | undefined,
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
        ...pendingRowsOf({
          author: {
            id: user?.id ?? "",
            image: user?.image ?? null,
            name: user?.name ?? null,
          },
          input,
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

/** The reader-annotation rows of the case-law reader and claim comments. */
export const useOptimisticAnnotationMutations = <
  TCreate,
  TCreated,
  TChange extends UpdateAnnotationInput,
>({
  pendingInput,
  ...requests
}: OptimisticAnnotationRequests<
  TCreate,
  TCreated,
  TChange
>): OptimisticAnnotationMutations<TCreate, TCreated, TChange> =>
  useOptimisticMarkMutations({
    ...requests,
    pendingRows: ({ author, input, stamp }) =>
      pendingRows({ author, input: pendingInput(input), stamp }),
  });
