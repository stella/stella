import { useRef, useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { Result } from "better-result";
import { useDebouncedCallback } from "use-debounce";

import type { ClauseParagraph } from "@/components/templates/clause-editor-types";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";

import {
  bodyKey,
  type ClauseEditorReviewStatus,
} from "./clause-ai-tracked-changes";

export type ClauseBodyWrite = {
  body: ClauseParagraph[];
  expectedBody: ClauseParagraph[];
  snapshotVersion?: boolean;
};

type BodyConflict =
  | { status: "none" }
  | { status: "choice"; head: ClauseParagraph[] };
type ClauseBodySaveOptions = {
  initialBody: ClauseParagraph[];
  persist: (write: ClauseBodyWrite) => Promise<unknown>;
  readHead?: (() => Promise<ClauseParagraph[]>) | undefined;
  onError: (error: unknown) => void;
  onPersisted?: ((body: ClauseParagraph[]) => void) | undefined;
};

const useClauseReviewGate = (getBodyKey: () => string) => {
  const [reviewStatus, setReviewStatus] =
    useState<ClauseEditorReviewStatus>("resolved");
  const reviewActivity = useRef<"pending" | "resolved">("resolved");
  const requiredReviewKey = useRef<string | null>(null);
  const syncReview = () => {
    if (reviewActivity.current === "pending") {
      setReviewStatus("pending");
      return;
    }
    setReviewStatus(
      requiredReviewKey.current === null ? "resolved" : "persisting",
    );
  };
  const onReviewStatusChange = (status: ClauseEditorReviewStatus) => {
    reviewActivity.current = status === "pending" ? "pending" : "resolved";
    if (status === "persisting" && requiredReviewKey.current === null) {
      requiredReviewKey.current = getBodyKey();
    }
    syncReview();
  };
  return {
    reviewStatus,
    onReviewStatusChange,
    isBlocked: () =>
      reviewActivity.current === "pending" ||
      requiredReviewKey.current !== null,
    adopt: () => {
      requiredReviewKey.current = null;
      syncReview();
    },
    acknowledge: (next: ClauseParagraph[]) => {
      if (requiredReviewKey.current !== bodyKey(next)) {
        return;
      }
      requiredReviewKey.current = null;
      syncReview();
    },
    change: (next: ClauseParagraph[]) => {
      if (requiredReviewKey.current !== null) {
        requiredReviewKey.current = bodyKey(next);
      }
    },
    resolve: (next: ClauseParagraph[]) => {
      reviewActivity.current = "resolved";
      requiredReviewKey.current = bodyKey(next);
      syncReview();
    },
  };
};

type ClauseBodyQueueOptions = {
  initialBody: ClauseParagraph[];
  reconcile: (head: ClauseParagraph[]) => void;
  report: (error: unknown) => void;
};
const useClauseBodyQueue = ({
  initialBody,
  reconcile,
  report,
}: ClauseBodyQueueOptions) => {
  const tail = useRef(Promise.resolve(true));
  const pending = useRef(0);
  const observedKey = useRef(bodyKey(initialBody));
  const deferredHead = useRef<ClauseParagraph[] | null>(null);
  const queuedAcknowledgements = useRef(new Set<string>());
  // Query deliveries feed the imperative save owner; an active write retains
  // its precondition until acknowledgement before reconciling that delivery.
  useExternalSyncEffect(() => {
    const key = bodyKey(initialBody);
    if (key === observedKey.current) {
      return;
    }
    observedKey.current = key;
    if (pending.current > 0) {
      if (queuedAcknowledgements.current.has(key)) {
        return;
      }
      deferredHead.current = initialBody;
      return;
    }
    reconcile(initialBody);
  }, [initialBody, reconcile]);

  const enqueue = (
    operation: (previousSucceeded: boolean) => Promise<boolean>,
  ) => {
    pending.current += 1;
    const settled = tail.current.then(async (previousSucceeded) => {
      const result = await Result.tryPromise(() =>
        operation(previousSucceeded),
      );
      pending.current -= 1;
      if (pending.current === 0 && deferredHead.current !== null) {
        const head = deferredHead.current;
        deferredHead.current = null;
        if (!queuedAcknowledgements.current.has(bodyKey(head))) {
          reconcile(head);
        }
      }
      if (pending.current === 0) {
        queuedAcknowledgements.current.clear();
      }
      if (result.isErr()) {
        report(result.error.cause);
        return false;
      }
      return result.value;
    });
    tail.current = settled;
    return settled;
  };
  return {
    enqueue,
    hasPending: () => pending.current > 0,
    acknowledge: (next: ClauseParagraph[]) => {
      if (pending.current > 0) {
        queuedAcknowledgements.current.add(bodyKey(next));
      }
    },
  };
};

type ClauseBodyTransportOptions = Pick<
  ClauseBodySaveOptions,
  "persist" | "readHead"
> & {
  getLive: () => ClauseParagraph[];
  getPersisted: () => ClauseParagraph[];
  hasConflict: () => boolean;
  acknowledged: (head: ClauseParagraph[]) => void;
  clearConflict: () => void;
  reconcile: (head: ClauseParagraph[]) => void;
  report: (error: unknown) => void;
};
const useClauseBodyTransport = ({
  persist,
  readHead,
  getLive,
  getPersisted,
  hasConflict,
  acknowledged,
  clearConflict,
  reconcile,
  report,
}: ClauseBodyTransportOptions) => {
  const mutation = useMutation({ mutationFn: persist, retry: false });
  const recoverConflict = useLatestCallback(async () => {
    if (!readHead) {
      return;
    }
    const fetched = await Result.tryPromise(readHead);
    if (fetched.isErr()) {
      report(fetched.error.cause);
      return;
    }
    const head = fetched.value;
    if (bodyKey(head) === bodyKey(getLive())) {
      acknowledged(head);
      clearConflict();
      return;
    }
    reconcile(head);
  });
  const write = useLatestCallback(
    async (next: ClauseParagraph[], snapshotVersion = false) => {
      if (hasConflict()) {
        return false;
      }
      const result = await Result.tryPromise(() =>
        mutation.mutateAsync({
          body: next,
          expectedBody: getPersisted(),
          ...(snapshotVersion ? { snapshotVersion: true } : {}),
        }),
      );
      if (result.isErr()) {
        const error = result.error.cause;
        if (APIError.is(error) && error.status === 409 && readHead) {
          await recoverConflict();
          return false;
        }
        report(error);
        return false;
      }
      acknowledged(next);
      return true;
    },
  );
  return { write, recoverConflict };
};

/** Head acknowledgements, version publication and review persistence share
 * one FIFO. External editor reseeds never count as local edits. */
export const useClauseBodySave = ({
  initialBody,
  persist,
  readHead,
  onError,
  onPersisted,
}: ClauseBodySaveOptions) => {
  const [body, setBody] = useState(initialBody);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<BodyConflict>({ status: "none" });
  const live = useRef({ body: initialBody, revision: 0 });
  const persisted = useRef(initialBody);
  const versionKey = useRef(bodyKey(initialBody));
  const conflictRef = useRef<BodyConflict>({ status: "none" });
  const review = useClauseReviewGate(() => bodyKey(live.current.body));

  const clearConflict = () => {
    conflictRef.current = { status: "none" };
    setConflict({ status: "none" });
  };
  const adopt = (head: ClauseParagraph[], published = false) => {
    const wasDirty = bodyKey(live.current.body) !== versionKey.current;
    persisted.current = head;
    live.current = { body: head, revision: live.current.revision + 1 };
    setBody(head);
    if (published || !wasDirty) {
      versionKey.current = bodyKey(head);
    }
    setDirty(bodyKey(head) !== versionKey.current);
    review.adopt();
    clearConflict();
  };
  const reconcile = useLatestCallback((head: ClauseParagraph[]) => {
    if (bodyKey(head) === bodyKey(persisted.current)) {
      return;
    }
    if (bodyKey(live.current.body) === bodyKey(persisted.current)) {
      adopt(head);
      return;
    }
    conflictRef.current = { status: "choice", head };
    setConflict({ status: "choice", head });
  });
  const report = useLatestCallback((error: unknown) => {
    const notified = Result.try(() => onError(error));
    if (notified.isErr()) {
      getAnalytics().captureError(notified.error.cause);
    }
  });
  const queue = useClauseBodyQueue({ initialBody, reconcile, report });
  const { enqueue } = queue;
  const acknowledged = (next: ClauseParagraph[]) => {
    persisted.current = next;
    queue.acknowledge(next);
    review.acknowledge(next);
    const notified = Result.try(() => onPersisted?.(next));
    if (notified.isErr()) {
      getAnalytics().captureError(notified.error.cause);
    }
  };
  const { write, recoverConflict } = useClauseBodyTransport({
    persist,
    readHead,
    getLive: () => live.current.body,
    getPersisted: () => persisted.current,
    hasConflict: () => conflictRef.current.status === "choice",
    acknowledged,
    clearConflict,
    reconcile,
    report,
  });
  const flush = useLatestCallback(() => {
    const captured = live.current.body;
    return enqueue(async () => {
      if (conflictRef.current.status === "choice") {
        return false;
      }
      if (bodyKey(persisted.current) === bodyKey(captured)) {
        acknowledged(captured);
        return true;
      }
      return write(captured);
    }).then(
      (saved) => saved && bodyKey(live.current.body) === bodyKey(captured),
    );
  });
  const debouncedSave = useDebouncedCallback(() => {
    detached(flush(), "clause-detail.autosave");
  }, 1200);
  const change = (next: ClauseParagraph[]) => {
    if (bodyKey(next) === bodyKey(live.current.body)) {
      return;
    }
    live.current = { body: next, revision: live.current.revision + 1 };
    setBody(next);
    setDirty(bodyKey(next) !== versionKey.current);
    review.change(next);
    if (conflictRef.current.status === "none") {
      debouncedSave();
    }
  };
  const snapshot = () => {
    if (review.isBlocked()) {
      return Promise.resolve(false);
    }
    debouncedSave.cancel();
    const captured = live.current;
    const joinsPending = queue.hasPending();
    return enqueue(async (previousSucceeded) => {
      if (joinsPending && !previousSucceeded) {
        return false;
      }
      if (!(await write(captured.body, true))) {
        return false;
      }
      versionKey.current = bodyKey(captured.body);
      setDirty(bodyKey(live.current.body) !== versionKey.current);
      return true;
    }).then(
      (saved) => saved && bodyKey(live.current.body) === bodyKey(captured.body),
    );
  };
  const sequenceHead = (
    operation: (expectedBody: ClauseParagraph[]) => Promise<ClauseParagraph[]>,
  ) => {
    debouncedSave.cancel();
    const captured = live.current;
    const joinsPending = queue.hasPending();
    return enqueue(async (previousSucceeded) => {
      if (
        (joinsPending && !previousSucceeded) ||
        conflictRef.current.status === "choice"
      ) {
        return false;
      }
      if (
        bodyKey(persisted.current) !== bodyKey(captured.body) &&
        !(await write(captured.body))
      ) {
        return false;
      }
      const result = await Result.tryPromise(() =>
        operation(persisted.current),
      );
      if (result.isErr()) {
        const error = result.error.cause;
        if (APIError.is(error) && error.status === 409 && readHead) {
          await recoverConflict();
        } else {
          report(error);
        }
        return false;
      }
      acknowledged(result.value);
      versionKey.current = bodyKey(result.value);
      if (live.current.revision === captured.revision) {
        adopt(result.value, true);
      } else {
        setDirty(bodyKey(live.current.body) !== versionKey.current);
      }
      return true;
    });
  };
  const resolveReview = async (next: ClauseParagraph[]) => {
    review.resolve(next);
    change(next);
    debouncedSave.cancel();
    return flush();
  };
  const keepMine = () => {
    if (conflictRef.current.status !== "choice") {
      return Promise.resolve(true);
    }
    persisted.current = conflictRef.current.head;
    clearConflict();
    return flush();
  };
  const takeTheirs = () => {
    if (conflictRef.current.status !== "choice") {
      return;
    }
    debouncedSave.cancel();
    adopt(conflictRef.current.head, true);
  };
  return {
    body,
    dirty,
    conflict,
    reviewStatus: review.reviewStatus,
    change,
    flush,
    snapshot,
    sequenceHead,
    onReviewStatusChange: review.onReviewStatusChange,
    resolveReview,
    keepMine,
    takeTheirs,
  };
};
