import { useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

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
import type { ReaderAnnotationWrites } from "@/components/legal-reader/annotations/reader-annotation-history.logic";
import { readerAnnotationTargetKey } from "@/components/legal-reader/annotations/reader-annotation-target";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import {
  readerAnnotationKeys,
  readerAnnotationsOptions,
} from "@/components/legal-reader/annotations/reader-annotations-query";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import { useReaderAnnotationHistory } from "@/components/legal-reader/annotations/use-reader-annotation-history";
import type { ReaderAnnotationController } from "@/components/legal-reader/annotations/use-reader-annotation-history";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useSessionStorage } from "@/hooks/use-session-storage";
import { SIGNED_OUT_QUERY_OWNER } from "@/lib/account/queries";
import {
  isCurrentStorageOwner,
  storageOwner,
} from "@/lib/account/user-scoped-storage";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { createUuid } from "@/lib/uuid";

/** A mark not yet acknowledged by the server, keyed so it can be told apart. */
const PENDING_ID_PREFIX = "pending:";

/** A mark the server has not stored yet cannot be changed or removed. */
export const isPendingAnnotationId = (id: string): boolean =>
  id.startsWith(PENDING_ID_PREFIX);

/** Guest migration is bounded so signing in never opens a request flood. */
const GUEST_ANNOTATION_MIGRATION_CONCURRENCY = 4;

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
    userId: user?.id ?? SIGNED_OUT_QUERY_OWNER,
    ...targetKey,
  });
  const queryKey = annotationsQuery.queryKey;
  const dataQuery = useQuery({ ...annotationsQuery, enabled: user !== null });
  const dataView = useQueryView(dataQuery);
  useQueryViewError(dataView);
  const data = dataView.type === "items" ? dataView.items : undefined;

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
      notifyUserError(error, t("errors.actionFailed"));
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
    const migrationOwner = storageOwner();
    detached(
      (async () => {
        const results = await mapWithConcurrency({
          items: store.items,
          limit: GUEST_ANNOTATION_MIGRATION_CONCURRENCY,
          operation: async (item) => {
            if (!isCurrentStorageOwner(migrationOwner)) {
              return Result.ok(undefined);
            }
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
              return migrated;
            }
            if (!isCurrentStorageOwner(migrationOwner)) {
              return Result.ok(undefined);
            }
            const removed = removeGuestAnnotation(storage, item.requestId);
            if (Result.isError(removed)) {
              getAnalytics().captureError(removed.error, {
                operation: "legal-reader.guest-annotation.migrate",
                type: "detached",
              });
              return removed;
            }
            return Result.ok(undefined);
          },
        });
        if (!isCurrentStorageOwner(migrationOwner)) {
          return;
        }
        setStore(readGuestAnnotationStore(storage));
        await queryClient.invalidateQueries({
          queryKey: readerAnnotationKeys.all,
        });
        const failed = results.find((result) => result.status === "error");
        if (failed) {
          notifyUserError(
            failed.error,
            t("legalReader.annotations.guestMigrationFailed"),
          );
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

  // Steps belong to one document under one account: signing in, switching
  // organization or opening another document starts a fresh history.
  const historyScope = [
    user?.id ?? "guest",
    user?.activeOrganizationId ?? "",
    targetKey.targetType,
    targetKey.targetId,
  ].join(":");

  // The tab's marks as they are now, not as this render saw them: a step
  // taken right after another reads what that one left.
  const currentGuestStore = () =>
    storage === null ? guestStore : readGuestAnnotationStore(storage);

  const commit = (
    next: typeof guestStore,
    action: "create" | "delete" | "update",
  ): Result<void, Error> => {
    if (storage === null) {
      notifyUserError(
        undefined,
        t("legalReader.annotations.guestStorageUnavailable"),
      );
      return Result.err(
        new ClientOperationError({
          action: `${action}-guest-reader-annotation`,
          message: "Guest annotation storage is unavailable",
        }),
      );
    }
    const stored = writeGuestAnnotationStore(storage, next);
    if (Result.isError(stored)) {
      getAnalytics().captureError(stored.error, {
        operation: `legal-reader.guest-annotation.${action}`,
        type: "detached",
      });
      notifyUserError(
        stored.error,
        t("legalReader.annotations.guestStorageUnavailable"),
      );
      return Result.err(stored.error);
    }
    setStore(next);
    return Result.ok(undefined);
  };

  const guestWrites: ReaderAnnotationWrites = {
    create: async (input: CreateAnnotationInput) => {
      const before = currentGuestStore();
      if (before.items.length >= GUEST_ANNOTATIONS_MAX_ITEMS) {
        notifyUserError(
          undefined,
          t("legalReader.annotations.guestLimitReached", {
            count: String(GUEST_ANNOTATIONS_MAX_ITEMS),
          }),
        );
        return Result.err(
          new ClientOperationError({
            action: "create-guest-reader-annotation",
            message: "Guest annotation limit reached",
          }),
        );
      }
      const next = createGuestAnnotation({
        input,
        newId: createUuid,
        now: new Date(Temporal.Now.instant().epochMilliseconds),
        store: before,
        target: targetKey,
      });
      const created = optionalArray(next.items.at(-1)?.rowIds);
      return await Promise.resolve(commit(next, "create").map(() => created));
    },
    remove: async (id: string) =>
      await Promise.resolve(
        commit(deleteGuestAnnotation(currentGuestStore(), id), "delete"),
      ),
    rows: () =>
      guestAnnotationRows({
        authorName: t("legalReader.annotations.guestAuthor"),
        store: currentGuestStore(),
        target: targetKey,
      }),
    update: async (input: UpdateAnnotationInput) =>
      await Promise.resolve(
        commit(updateGuestAnnotation(currentGuestStore(), input), "update"),
      ),
  };

  // A failed write has already rolled the cache back and told the reader why
  // (`settle.onError`); the result only says whether it held.
  const accountWrites: ReaderAnnotationWrites = {
    create: async (input: CreateAnnotationInput) =>
      (await Result.tryPromise(async () => create.mutateAsync(input))).map(
        (created) => created.ids,
      ),
    remove: async (id: string) =>
      (await Result.tryPromise(async () => remove.mutateAsync(id))).map(
        () => undefined,
      ),
    // The cache, not this render: it already holds what a write just stored.
    rows: () => optionalArray(queryClient.getQueryData(queryKey)),
    update: async (input: UpdateAnnotationInput) =>
      (await Result.tryPromise(async () => update.mutateAsync(input))).map(
        () => undefined,
      ),
  };

  const controller = useReaderAnnotationHistory({
    scope: historyScope,
    writes: user === null ? guestWrites : accountWrites,
  });

  if (user !== null) {
    return {
      annotations: optionalArray(data),
      controller,
      guestCount: 0,
      mode: "authenticated",
    };
  }

  return {
    annotations: guestAnnotationRows({
      authorName: t("legalReader.annotations.guestAuthor"),
      store: guestStore,
      target: targetKey,
    }),
    controller,
    guestCount: guestAnnotationsOnTarget(guestStore, targetKey).length,
    mode: "guest",
  };
};
