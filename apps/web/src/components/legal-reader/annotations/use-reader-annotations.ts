import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { stellaToast } from "@stll/ui/toast";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/components/legal-reader/annotations/annotation-types";
import {
  claimGuestAnnotations,
  createGuestAnnotation,
  deleteGuestAnnotation,
  EMPTY_GUEST_ANNOTATION_STORE,
  GUEST_ANNOTATIONS_MAX_ITEMS,
  guestAnnotationRows,
  guestAnnotationsOnTarget,
  readGuestAnnotationStore,
  updateGuestAnnotation,
  uploadClaimedGuestAnnotations,
  writeGuestAnnotationStore,
} from "@/components/legal-reader/annotations/guest-annotation-store.logic";
import type { GuestAnnotation } from "@/components/legal-reader/annotations/guest-annotation-store.logic";
import type { ReaderAnnotationWrites } from "@/components/legal-reader/annotations/reader-annotation-history.logic";
import { readerAnnotationTargetKey } from "@/components/legal-reader/annotations/reader-annotation-target";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import {
  readerAnnotationKeys,
  readerAnnotationsOptions,
} from "@/components/legal-reader/annotations/reader-annotations-query";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import { useOptimisticAnnotationMutations } from "@/components/legal-reader/annotations/use-optimistic-annotation-mutations";
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
import { unwrapApiResponse } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";
import { createUuid } from "@/lib/uuid";

/** Guest migration is bounded so signing in never opens a request flood. */
const GUEST_ANNOTATION_MIGRATION_CONCURRENCY = 4;

/** Posts one guest mark to the signed-in account under its own request id. */
const uploadGuestAnnotation = async (
  item: GuestAnnotation,
): Promise<Result<void, Error>> =>
  await Result.tryPromise(async () => {
    const response = await api.reader.annotations.post({
      ...item.input,
      requestId: toSafeId<"legalReaderAnnotation">(item.requestId),
      targetId: item.targetId,
      targetType: item.targetType,
    });
    unwrapApiResponse(response);
  });

/** One failure per mark, grouped by the kind of document it was made on. */
const captureGuestMigrationFailure = (
  item: GuestAnnotation,
  error: Error,
): void => {
  getAnalytics().captureError(error, {
    fingerprintKey: "useReaderAnnotations.operation:failure",
    scope: {
      type: "handler",
      handlerId: `reader-annotations.guest.${item.targetType}.migrate`,
    },
    context: {
      operation: "legal-reader.guest-annotation.migrate",
      type: "detached",
    },
  });
};

/** The tab could not claim the guest marks for the signed-in account. */
const captureGuestClaimFailure = (error: Error): void => {
  getAnalytics().captureError(error, {
    fingerprintKey: "useReaderAnnotations.claim:failure",
    scope: { type: "handler", handlerId: "reader-annotations.guest.claim" },
    context: {
      operation: "legal-reader.guest-annotation.migrate",
      type: "detached",
    },
  });
};

type ReaderAnnotations = {
  annotations: readonly ReaderAnnotation[];
  controller: ReaderAnnotationController;
  /** Marks this tab holds that no account owns yet. */
  guestCount: number;
  mode: "authenticated" | "guest";
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
  const targetKey = readerAnnotationTargetKey(target);

  const annotationsQuery = readerAnnotationsOptions({
    activeOrganizationId: user?.activeOrganizationId ?? "",
    userId: user?.id ?? SIGNED_OUT_QUERY_OWNER,
    ...targetKey,
  });
  const queryKey = annotationsQuery.queryKey;
  const dataQuery = useQuery({ ...annotationsQuery, enabled: user !== null });
  const dataView = queryView(dataQuery);
  useQueryViewError(dataView, `useReaderAnnotations.${target.type}:query`);
  const data = dataView.type === "items" ? dataView.items : undefined;

  const { create, remove, update } = useOptimisticAnnotationMutations({
    handlerId: `reader-annotations.${target.type}`,
    create: async (input: CreateAnnotationInput) => {
      const response = await api.reader.annotations.post({
        ...input,
        ...targetKey,
      });
      return unwrapApiResponse(response);
    },
    pendingInput: (input) => input,
    queryKey,
    remove: async (id: string) => {
      const response = await api.reader
        .annotations({ annotationId: toSafeId<"legalReaderAnnotation">(id) })
        .delete();
      return unwrapApiResponse(response);
    },
    update: async ({ id, ...change }: UpdateAnnotationInput) => {
      const response = await api.reader
        .annotations({ annotationId: toSafeId<"legalReaderAnnotation">(id) })
        .patch(change);
      return unwrapApiResponse(response);
    },
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
    const migrationOwner = storageOwner();
    if (migrationOwner.kind !== "user") {
      return;
    }
    // Claimed under this account first: a sign-out mid-upload then leaves the
    // rest waiting for its next sign-in in this tab.
    const claimed = claimGuestAnnotations(storage, migrationOwner);
    if (Result.isError(claimed)) {
      captureGuestClaimFailure(claimed.error);

      notifyUserError(
        claimed.error,
        t("legalReader.annotations.guestMigrationFailed"),
      );
      return;
    }
    const { items } = claimed.value;
    if (items.length === 0) {
      return;
    }
    detached(
      (async () => {
        const results = await uploadClaimedGuestAnnotations({
          isCurrentOwner: () => isCurrentStorageOwner(migrationOwner),
          items,
          limit: GUEST_ANNOTATION_MIGRATION_CONCURRENCY,
          owner: migrationOwner,
          storage,
          upload: uploadGuestAnnotation,
        });
        for (const [index, result] of results.entries()) {
          const item = items[index];
          if (Result.isError(result) && item !== undefined) {
            captureGuestMigrationFailure(item, result.error);
          }
        }
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

  // The tab's marks as they are now, not as this render saw them: a step
  // taken right after another reads what that one left.
  const currentGuestStore = () =>
    storage === null ? guestStore : readGuestAnnotationStore(storage);

  const commit = (
    next: typeof guestStore,
    action: GuestAnnotationAction,
  ): Result<void, Error> => {
    const persisted = persistGuestAnnotationStore({
      action,
      next,
      storage,
      unavailableMessage: t("legalReader.annotations.guestStorageUnavailable"),
      targetType: target.type,
    });
    if (Result.isOk(persisted)) {
      setStore(next);
    }
    return persisted;
  };

  const guestWrites: ReaderAnnotationWrites = {
    create: async (input: CreateAnnotationInput) => {
      const before = currentGuestStore();
      if (before.items.length >= GUEST_ANNOTATIONS_MAX_ITEMS) {
        notifyUserProblem(
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

  const controller = useReaderAnnotationHistory({
    scope: readerAnnotationHistoryScope(user, targetKey),
    writes:
      user === null
        ? guestWrites
        : accountAnnotationWrites({
            mutations: { create, remove, update },
            // The cache, not this render: it already holds what a write just
            // stored.
            rows: () => optionalArray(queryClient.getQueryData(queryKey)),
          }),
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

type HistoryScopeUser = {
  id: string;
  activeOrganizationId?: string | null | undefined;
};

/** Steps belong to one document under one account: signing in, switching
 * organization or opening another document starts a fresh history. */
function readerAnnotationHistoryScope(
  user: HistoryScopeUser | null,
  targetKey: { targetId: string; targetType: string },
): string {
  return [
    user?.id ?? "guest",
    user?.activeOrganizationId ?? "",
    targetKey.targetType,
    targetKey.targetId,
  ].join(":");
}

type AccountAnnotationWritesOptions = {
  mutations: {
    create: (
      input: CreateAnnotationInput,
    ) => Promise<{ ids: readonly string[] }>;
    remove: (id: string) => Promise<unknown>;
    update: (input: UpdateAnnotationInput) => Promise<unknown>;
  };
  rows: () => readonly ReaderAnnotation[];
};

/** A failed write has already rolled the cache back and told the reader why
 * (the mutations' error handler); the result only says whether it held. */
function accountAnnotationWrites({
  mutations: { create, remove, update },
  rows,
}: AccountAnnotationWritesOptions): ReaderAnnotationWrites {
  return {
    create: async (input) =>
      (await Result.tryPromise(async () => create(input))).map(
        (created) => created.ids,
      ),
    remove: async (id) =>
      (await Result.tryPromise(async () => remove(id))).map(() => undefined),
    rows,
    update: async (input) =>
      (await Result.tryPromise(async () => update(input))).map(() => undefined),
  };
}

type GuestAnnotationAction = "create" | "delete" | "update";

type PersistGuestAnnotationStoreOptions = {
  action: GuestAnnotationAction;
  targetType: ReaderAnnotationTarget["type"];
  next: Parameters<typeof writeGuestAnnotationStore>[1];
  storage: Parameters<typeof writeGuestAnnotationStore>[0] | null;
  unavailableMessage: string;
};

/** Writes the tab's marks, telling the reader when the tab cannot keep them. */
function persistGuestAnnotationStore({
  action,
  targetType,
  next,
  storage,
  unavailableMessage,
}: PersistGuestAnnotationStoreOptions): Result<void, Error> {
  if (storage === null) {
    notifyUserProblem(unavailableMessage);
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
      fingerprintKey: "useReaderAnnotations.commit:failure",
      scope: {
        type: "handler",
        handlerId: `reader-annotations.guest.${targetType}.${action}`,
      },
      context: {
        operation: `legal-reader.guest-annotation.${action}`,
        type: "detached",
      },
    });
    notifyUserError(stored.error, unavailableMessage);
    return Result.err(stored.error);
  }
  return Result.ok(undefined);
}
