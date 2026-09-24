import { useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";

import { mapWithConcurrency } from "@stll/concurrency";
import { Temporal } from "@stll/time";
import { stellaToast } from "@stll/ui/toast";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import {
  createGuestAnnotation,
  deleteGuestAnnotation,
  EMPTY_GUEST_ANNOTATION_STORE,
  GUEST_ANNOTATIONS_MAX_ITEMS,
  guestAnnotationRows,
  guestAnnotationsOnTarget,
  readGuestAnnotationStore,
  removeGuestAnnotation,
  updateGuestAnnotation,
  writeGuestAnnotationStore,
} from "@/components/legal-reader/annotations/guest-annotation-store.logic";
import { readerAnnotationTargetKey } from "@/components/legal-reader/annotations/reader-annotation-target";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import {
  readerAnnotationKeys,
  readerAnnotationsOptions,
} from "@/components/legal-reader/annotations/reader-annotations-query";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useSessionStorage } from "@/hooks/use-session-storage";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

/** A mark not yet acknowledged by the server, keyed so it can be told apart. */
const PENDING_ID_PREFIX = "pending:";

/** A mark the server has not stored yet cannot be changed or removed. */
export const isPendingAnnotationId = (id: string): boolean =>
  id.startsWith(PENDING_ID_PREFIX);

/** Guest migration is bounded so signing in never opens a request flood. */
const GUEST_ANNOTATION_MIGRATION_CONCURRENCY = 4;

/** The three things a reader does to a mark, wherever the mark is kept. */
export type ReaderAnnotationController = {
  create: (input: CreateAnnotationInput) => unknown;
  remove: (id: string) => unknown;
  update: (input: UpdateAnnotationInput) => unknown;
};

type ReaderAnnotations = {
  annotations: readonly ReaderAnnotation[];
  controller: ReaderAnnotationController;
  /** Marks this tab holds that no account owns yet. */
  guestCount: number;
  mode: "authenticated" | "guest";
};

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

/**
 * The reader's marks on the document on screen, with the three ways to change
 * them. One hook for both corpora and both kinds of reader: with an account
 * every change lands in the cache at once so the text answers the reader's
 * hand and is then refetched, because the server is the one that knows what a
 * colleague shared meanwhile; without one the marks live in this tab until
 * the reader creates an account, when they are posted and cleared.
 */
export const useReaderAnnotations = (
  target: ReaderAnnotationTarget,
): ReaderAnnotations => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const storage = useSessionStorage();
  const [localStore, setStore] = useState(EMPTY_GUEST_ANNOTATION_STORE);
  const pendingSequence = useRef(0);
  const targetKey = readerAnnotationTargetKey(target);

  const annotationsQuery = readerAnnotationsOptions({
    activeOrganizationId: user?.activeOrganizationId ?? "",
    ...targetKey,
  });
  const queryKey = annotationsQuery.queryKey;
  const { data } = useQuery({ ...annotationsQuery, enabled: user !== null });

  const patchCache = async (
    patch: (rows: readonly ReaderAnnotation[]) => ReaderAnnotation[],
  ): Promise<{ previous: ReaderAnnotation[] | undefined }> => {
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData(queryKey);
    queryClient.setQueryData(queryKey, (rows) => patch(optionalArray(rows)));
    return { previous };
  };

  const settle = {
    onError: (
      error: unknown,
      _input: unknown,
      context: { previous: ReaderAnnotation[] | undefined } | undefined,
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
      const response = await api.reader.annotations.post({
        ...input,
        ...targetKey,
      });
      return unwrapEden(response);
    },
    onMutate: async (input) => {
      // Tells pending marks apart within one reader; only ever advanced on a
      // click, never while rendering.
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
          input,
          stamp,
        }),
      ]);
    },
    ...settle,
  });

  const update = useMutation({
    mutationFn: async ({ id, ...change }: UpdateAnnotationInput) => {
      const response = await api.reader
        .annotations({ annotationId: toSafeId<"legalReaderAnnotation">(id) })
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
      const response = await api.reader
        .annotations({ annotationId: toSafeId<"legalReaderAnnotation">(id) })
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

  // Whatever this tab still holds from before the reader had an account.
  const guestStore =
    storage !== null && localStore === EMPTY_GUEST_ANNOTATION_STORE
      ? readGuestAnnotationStore(storage)
      : localStore;

  const signedIn = user !== null;
  useExternalSyncEffect(() => {
    if (!signedIn || storage === null) {
      return;
    }
    const store = readGuestAnnotationStore(storage);
    if (store.items.length === 0) {
      return;
    }
    detached(
      (async () => {
        const results = await mapWithConcurrency({
          items: store.items,
          limit: GUEST_ANNOTATION_MIGRATION_CONCURRENCY,
          operation: async (item) => {
            const migrated = await Result.tryPromise(async () => {
              const response = await api.reader.annotations.post({
                ...item.input,
                requestId: toSafeId<"legalReaderAnnotation">(item.requestId),
                targetId: item.targetId,
                targetType: item.targetType,
              });
              unwrapEden(response);
            });
            if (Result.isError(migrated)) {
              getAnalytics().captureError(migrated.error, {
                operation: "legal-reader.guest-annotation.migrate",
                type: "detached",
              });
              return false;
            }
            const removed = removeGuestAnnotation(storage, item.requestId);
            if (Result.isError(removed)) {
              getAnalytics().captureError(removed.error, {
                operation: "legal-reader.guest-annotation.migrate",
                type: "detached",
              });
              return false;
            }
            return true;
          },
        });
        setStore(readGuestAnnotationStore(storage));
        await queryClient.invalidateQueries({
          queryKey: readerAnnotationKeys.all,
        });
        if (results.some((saved) => !saved)) {
          stellaToast.add({
            title: t("legalReader.annotations.guestMigrationFailed"),
            type: "error",
          });
          return;
        }
        stellaToast.add({
          title: t("legalReader.annotations.guestMigrationComplete"),
          type: "success",
        });
      })(),
      "legal-reader.migrate-guest-annotations",
    );
  }, [queryClient, signedIn, storage, t]);

  if (user !== null) {
    return {
      annotations: optionalArray(data),
      controller: {
        create: create.mutateAsync,
        remove: remove.mutateAsync,
        update: update.mutateAsync,
      },
      guestCount: 0,
      mode: "authenticated",
    };
  }

  const commit = (
    next: typeof guestStore,
    action: "create" | "delete" | "update",
  ) => {
    if (storage === null) {
      stellaToast.add({
        title: t("legalReader.annotations.guestStorageUnavailable"),
        type: "error",
      });
      return;
    }
    const stored = writeGuestAnnotationStore(storage, next);
    if (Result.isError(stored)) {
      getAnalytics().captureError(stored.error, {
        operation: `legal-reader.guest-annotation.${action}`,
        type: "detached",
      });
      stellaToast.add({
        title: t("legalReader.annotations.guestStorageUnavailable"),
        type: "error",
      });
      return;
    }
    setStore(next);
  };

  return {
    annotations: guestAnnotationRows({
      authorName: t("legalReader.annotations.guestAuthor"),
      store: guestStore,
      target: targetKey,
    }),
    controller: {
      create: (input: CreateAnnotationInput) => {
        if (guestStore.items.length >= GUEST_ANNOTATIONS_MAX_ITEMS) {
          stellaToast.add({
            title: t("legalReader.annotations.guestLimitReached", {
              count: String(GUEST_ANNOTATIONS_MAX_ITEMS),
            }),
            type: "error",
          });
          return;
        }
        commit(
          createGuestAnnotation({
            input,
            newId: uuidv7,
            now: new Date(),
            store: guestStore,
            target: targetKey,
          }),
          "create",
        );
      },
      remove: (id: string) => {
        commit(deleteGuestAnnotation(guestStore, id), "delete");
      },
      update: (input: UpdateAnnotationInput) => {
        commit(updateGuestAnnotation(guestStore, input), "update");
      },
    },
    guestCount: guestAnnotationsOnTarget(guestStore, targetKey).length,
    mode: "guest",
  };
};
