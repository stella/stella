import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
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
import { readerAnnotationTargetKey } from "@/components/legal-reader/annotations/reader-annotation-target";
import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import {
  readerAnnotationKeys,
  readerAnnotationsOptions,
} from "@/components/legal-reader/annotations/reader-annotations-query";
import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import { useOptimisticAnnotationMutations } from "@/components/legal-reader/annotations/use-optimistic-annotation-mutations";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useSessionStorage } from "@/hooks/use-session-storage";
import { SIGNED_OUT_QUERY_OWNER } from "@/lib/account/queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { optionalArray } from "@/lib/arrays";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { createUuid } from "@/lib/uuid";

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
  const dataView = useQueryView(dataQuery);
  useQueryViewError(dataView);
  const data = dataView.type === "items" ? dataView.items : undefined;

  const { create, remove, update } = useOptimisticAnnotationMutations({
    create: async (input: CreateAnnotationInput) => {
      const response = await api.reader.annotations.post({
        ...input,
        ...targetKey,
      });
      return unwrapEden(response);
    },
    pendingInput: (input) => input,
    queryKey,
    remove: async (id: string) => {
      const response = await api.reader
        .annotations({ annotationId: toSafeId<"legalReaderAnnotation">(id) })
        .delete();
      return unwrapEden(response);
    },
    update: async ({ id, ...change }: UpdateAnnotationInput) => {
      const response = await api.reader
        .annotations({ annotationId: toSafeId<"legalReaderAnnotation">(id) })
        .patch(change);
      return unwrapEden(response);
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
              return migrated;
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

  if (user !== null) {
    return {
      annotations: optionalArray(data),
      controller: { create, remove, update },
      guestCount: 0,
      mode: "authenticated",
    };
  }

  const commit = (
    next: typeof guestStore,
    action: "create" | "delete" | "update",
  ) => {
    if (storage === null) {
      notifyUserError(
        undefined,
        t("legalReader.annotations.guestStorageUnavailable"),
      );
      return;
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
          notifyUserError(
            undefined,
            t("legalReader.annotations.guestLimitReached", {
              count: String(GUEST_ANNOTATIONS_MAX_ITEMS),
            }),
          );
          return;
        }
        commit(
          createGuestAnnotation({
            input,
            newId: createUuid,
            now: new Date(Temporal.Now.instant().epochMilliseconds),
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
