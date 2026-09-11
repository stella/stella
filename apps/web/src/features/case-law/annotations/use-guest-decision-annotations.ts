import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";

import { stellaToast } from "@stll/ui/toast";

import type {
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@/features/case-law/annotations/annotation-types";
import {
  createGuestAnnotation,
  deleteGuestAnnotation,
  EMPTY_GUEST_ANNOTATION_STORE,
  GUEST_ANNOTATIONS_MAX_ITEMS,
  guestAnnotationRows,
  readGuestAnnotationStore,
  updateGuestAnnotation,
  writeGuestAnnotationStore,
} from "@/features/case-law/annotations/guest-annotation-store.logic";
import { useSessionStorage } from "@/hooks/use-session-storage";
import { getAnalytics } from "@/lib/analytics/provider";
import type { SafeId } from "@/lib/safe-id";

export const useGuestDecisionAnnotations = (
  decisionId: SafeId<"caseLawDecision">,
) => {
  const t = useTranslations();
  const storage = useSessionStorage();
  const [localStore, setStore] = useState(EMPTY_GUEST_ANNOTATION_STORE);
  const store =
    storage !== null && localStore === EMPTY_GUEST_ANNOTATION_STORE
      ? readGuestAnnotationStore(storage)
      : localStore;

  const commit = (
    next: typeof store,
    action: "create" | "delete" | "update",
  ) => {
    if (storage === null) {
      stellaToast.add({
        title: t("caseLaw.annotations.guestStorageUnavailable"),
        type: "error",
      });
      return false;
    }
    const stored = writeGuestAnnotationStore(storage, next);
    if (Result.isError(stored)) {
      getAnalytics().captureError(stored.error, {
        operation: `case-law.guest-annotation.${action}`,
        type: "detached",
      });
      stellaToast.add({
        title: t("caseLaw.annotations.guestStorageUnavailable"),
        type: "error",
      });
      return false;
    }
    setStore(next);
    return true;
  };

  const create = (input: CreateAnnotationInput) => {
    if (store.items.length >= GUEST_ANNOTATIONS_MAX_ITEMS) {
      stellaToast.add({
        title: t("caseLaw.annotations.guestLimitReached", {
          count: String(GUEST_ANNOTATIONS_MAX_ITEMS),
        }),
        type: "error",
      });
      return;
    }
    const next = createGuestAnnotation({
      decisionId,
      input,
      newId: uuidv7,
      now: new Date(),
      store,
    });
    commit(next, "create");
  };

  const remove = (id: string) => {
    commit(deleteGuestAnnotation(store, id), "delete");
  };

  const update = (input: UpdateAnnotationInput) => {
    commit(updateGuestAnnotation(store, input), "update");
  };

  const annotations = guestAnnotationRows({
    authorName: t("caseLaw.annotations.guestAuthor"),
    decisionId,
    store,
  });
  const count = store.items.filter(
    (item) => item.decisionId === decisionId,
  ).length;

  return { annotations, count, create, remove, update };
};
