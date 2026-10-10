import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DataTag, QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";

import type {
  ReaderAnswer,
  ReaderAnswerAnchor,
} from "@stll/api-contract/reader-answers";
import { Temporal } from "@stll/time";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLocale } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { APIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

import {
  changeReaderAnswerVisibility,
  deleteReaderAnswer,
  readerAnswersOptions,
  streamReaderAnswer,
} from "./reader-answers-query";
import {
  applyReaderAnswerEvent,
  ReaderAnswerFailure,
} from "./reader-answers.logic";

const createReaderAnswerRuntime = (scope: string) => {
  let phase: "active" | "cancelled" = "active";
  const controllers = new Set<AbortController>();
  return {
    scope,
    controllers,
    busy: new Set<string>(),
    isCancelled: () => phase === "cancelled",
    reactivate: () => {
      phase = "active";
    },
    cancel: () => {
      phase = "cancelled";
      for (const controller of controllers) {
        controller.abort();
      }
    },
  };
};
type ReaderAnswerErrors = ReadonlyMap<string, APIError | ReaderAnswerFailure>;
type StreamAnswerOptions = {
  answerId: string | null;
  path: string;
  body: object;
  anchor?: ReaderAnswerAnchor;
  regenerate: boolean;
};
type RunStreamAnswerOptions = StreamAnswerOptions & {
  signal: AbortSignal;
  runtime: ReturnType<typeof createReaderAnswerRuntime>;
  queryClient: QueryClient;
  decisionId: string;
  userId: string;
  setActiveAnswerId: Dispatch<SetStateAction<string | null>>;
  setBusyAnswerIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setErrors: Dispatch<SetStateAction<ReaderAnswerErrors>>;
};
const runStreamAnswer = async (
  queryKey: DataTag<readonly unknown[], ReaderAnswer[]>,
  {
    answerId,
    path,
    body,
    anchor,
    regenerate,
    signal,
    runtime,
    queryClient,
    decisionId,
    userId,
    setActiveAnswerId,
    setBusyAnswerIds,
    setErrors,
  }: RunStreamAnswerOptions,
) => {
  let currentAnswerId = answerId;
  const streaming = await Result.tryPromise({
    try: () =>
      streamReaderAnswer({
        path,
        body,
        signal,
        onEvent: (event) => {
          if (runtime.isCancelled() || signal.aborted) {
            return;
          }
          if (event.type === "started") {
            currentAnswerId = event.answerId;
            setActiveAnswerId(event.answerId);
            setBusyAnswerIds(
              (current) => new Set([...current, event.answerId]),
            );
          }
          const id = currentAnswerId;
          if (id === null) {
            return;
          }
          // oxlint-disable-next-line no-restricted-properties -- A received SSE event timestamps an ephemeral client message; this callback never runs during SSR or hydration.
          const now = Temporal.Now.instant().toString();
          queryClient.setQueryData(
            queryKey,
            (current: ReaderAnswer[] | undefined) => {
              const answers = current ?? [];
              let answer = answers.find((item) => item.id === id);
              if (!answer && event.type === "started" && anchor) {
                answer = {
                  id: event.answerId,
                  decisionId: toSafeId<"caseLawDecision">(decisionId),
                  authorId: toSafeId<"user">(userId),
                  mine: true,
                  kind: "explain",
                  anchor,
                  visibility: "private",
                  messages: [],
                  createdAt: now,
                  updatedAt: now,
                };
              }
              if (!answer) {
                return answers;
              }
              const updated = applyReaderAnswerEvent({
                answer,
                event,
                regenerate,
                now,
              });
              return answers.some((item) => item.id === id)
                ? answers.map((item) => (item.id === id ? updated : item))
                : [...answers, updated];
            },
          );
          if (event.type !== "complete" && event.type !== "failed") {
            return;
          }
          if (event.type === "failed") {
            setErrors((current) =>
              new Map(current).set(
                id,
                new ReaderAnswerFailure({
                  kind: "model",
                  code: event.errorCode,
                  message: event.message,
                }),
              ),
            );
          }
        },
      }),
    catch: (cause) => cause,
  });
  if (runtime.isCancelled() || signal.aborted) {
    return;
  }
  if (streaming.isErr() && currentAnswerId !== null) {
    const failedId = currentAnswerId;
    queryClient.setQueryData(queryKey, (current: ReaderAnswer[] | undefined) =>
      current?.map((answer) =>
        answer.id === failedId
          ? {
              ...answer,
              messages: answer.messages.map((message) =>
                message.status === "streaming"
                  ? {
                      ...message,
                      status: "failed",
                      content: "",
                      citations: [],
                      errorCode: null,
                      invalidCitationCount: 0,
                    }
                  : message,
              ),
            }
          : answer,
      ),
    );
  }
  if (currentAnswerId !== null) {
    const completedId = currentAnswerId;
    setBusyAnswerIds((current) => {
      const next = new Set(current);
      next.delete(completedId);
      return next;
    });
  }
  await queryClient.invalidateQueries({ queryKey });
  if (streaming.isErr()) {
    throw streaming.error;
  }
};

type PerformReaderAnswerOperationOptions = Pick<
  RunStreamAnswerOptions,
  "runtime" | "queryClient" | "setBusyAnswerIds" | "setErrors"
> & {
  id: string | null;
  operation: (signal: AbortSignal) => Promise<void>;
  enabled: boolean;
  authenticated: boolean;
  setIsCreating: Dispatch<SetStateAction<boolean>>;
};
const performReaderAnswerOperation = async (
  queryKey: DataTag<readonly unknown[], ReaderAnswer[]>,
  {
    id,
    operation,
    enabled,
    authenticated,
    runtime,
    queryClient,
    setIsCreating,
    setBusyAnswerIds,
    setErrors,
  }: PerformReaderAnswerOperationOptions,
) => {
  if (!enabled || !authenticated || runtime.isCancelled()) {
    return;
  }
  await queryClient.cancelQueries({ queryKey });
  if (runtime.isCancelled()) {
    return;
  }
  const busyKey = id ?? "create";
  if (runtime.busy.has(busyKey)) {
    return;
  }
  if (
    id !== null &&
    queryClient
      .getQueryData(queryKey)
      ?.find((answer) => answer.id === id)
      ?.messages.some((message) => message.status === "streaming")
  ) {
    return;
  }
  runtime.busy.add(busyKey);
  const controller = new AbortController();
  runtime.controllers.add(controller);
  if (id === null) {
    setIsCreating(true);
  } else {
    setBusyAnswerIds((current) => new Set([...current, id]));
  }
  setErrors((current) => {
    const next = new Map(current);
    next.delete(busyKey);
    return next;
  });
  const outcome = await Result.tryPromise({
    try: () => operation(controller.signal),
    catch: (cause) => cause,
  });
  runtime.controllers.delete(controller);
  runtime.busy.delete(busyKey);
  if (runtime.isCancelled() || controller.signal.aborted) {
    return;
  }
  if (outcome.isErr()) {
    getAnalytics().captureError(outcome.error);
    const error =
      APIError.is(outcome.error) || ReaderAnswerFailure.is(outcome.error)
        ? outcome.error
        : new ReaderAnswerFailure({
            kind: "request",
            message: "Reader answer request failed",
          });
    setErrors((current) => new Map(current).set(busyKey, error));
  }
  if (id === null) {
    setIsCreating(false);
  } else {
    setBusyAnswerIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }
};

export type UseReaderAnswersOptions = { decisionId: string; enabled: boolean };
export const useReaderAnswers = ({
  decisionId,
  enabled,
}: UseReaderAnswersOptions) => {
  const user = useMaybeAuthenticatedUser();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const options = readerAnswersOptions({
    decisionId,
    organizationId: user?.activeOrganizationId ?? "",
    userId: user?.id ?? "",
  });
  const scope = `${user?.activeOrganizationId}:${user?.id}:${decisionId}:${enabled}`;
  const [runtime, setRuntime] = useState(() =>
    createReaderAnswerRuntime(scope),
  );
  const [activeAnswerId, setActiveAnswerId] = useState<string | null>(null);
  const [busyAnswerIds, setBusyAnswerIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [isCreating, setIsCreating] = useState(false);
  // A list refetch must not replace another thread's still-unsettled deltas.
  const query = useQuery({
    ...options,
    enabled:
      enabled && user !== null && !isCreating && busyAnswerIds.size === 0,
  });
  const [errors, setErrors] = useState<ReaderAnswerErrors>(new Map());
  if (runtime.scope !== scope) {
    runtime.cancel();
    setRuntime(createReaderAnswerRuntime(scope));
    setActiveAnswerId(null);
    setBusyAnswerIds(new Set());
    setIsCreating(false);
    setErrors(new Map());
  }
  useExternalSyncEffect(() => {
    runtime.reactivate();
    return () => runtime.cancel();
  }, [runtime]);

  const perform = (
    id: string | null,
    operation: (signal: AbortSignal) => Promise<void>,
  ) =>
    performReaderAnswerOperation(options.queryKey, {
      id,
      operation,
      enabled,
      authenticated: user !== null,
      runtime,
      queryClient,
      setIsCreating,
      setBusyAnswerIds,
      setErrors,
    });
  const run = (input: StreamAnswerOptions) =>
    perform(input.answerId, (signal) =>
      runStreamAnswer(options.queryKey, {
        ...input,
        signal,
        runtime,
        queryClient,
        decisionId,
        userId: user?.id ?? "",
        setActiveAnswerId,
        setBusyAnswerIds,
        setErrors,
      }),
    );
  return {
    answers: query.data ?? [],
    activeAnswerId,
    setActiveAnswerId,
    busyAnswerIds,
    isCreating,
    errors,
    error: errors.get("create") ?? query.error,
    isLoading: query.isLoading,
    createExplain: (anchor: ReaderAnswerAnchor) =>
      run({
        answerId: null,
        path: "",
        body: {
          decisionId: toSafeId<"caseLawDecision">(decisionId),
          kind: "explain",
          anchor,
          locale,
        },
        anchor,
        regenerate: false,
      }),
    followUp: (answerId: string, question: string) =>
      run({
        answerId,
        path: `/${encodeURIComponent(answerId)}/messages`,
        body: { question, locale },
        regenerate: false,
      }),
    regenerate: (answerId: string) =>
      run({
        answerId,
        path: `/${encodeURIComponent(answerId)}/regenerate`,
        body: { locale },
        regenerate: true,
      }),
    remove: (answerId: string) =>
      perform(answerId, async (signal) => {
        await deleteReaderAnswer(answerId, signal);
        if (runtime.isCancelled() || signal.aborted) {
          return;
        }
        queryClient.setQueryData(
          options.queryKey,
          (current: ReaderAnswer[] | undefined) =>
            current?.filter((answer) => answer.id !== answerId),
        );
        setActiveAnswerId((current) => (current === answerId ? null : current));
      }),
    setVisibility: (answerId: string, visibility: ReaderAnswer["visibility"]) =>
      perform(answerId, async (signal) => {
        await changeReaderAnswerVisibility(answerId, visibility, signal);
        if (runtime.isCancelled() || signal.aborted) {
          return;
        }
        queryClient.setQueryData(
          options.queryKey,
          (current: ReaderAnswer[] | undefined) =>
            current?.map((answer) =>
              answer.id === answerId ? { ...answer, visibility } : answer,
            ),
        );
      }),
  };
};
