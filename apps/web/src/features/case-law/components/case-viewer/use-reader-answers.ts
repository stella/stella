import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DataTag, QueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";

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
import { readQueryResult } from "@/lib/errors/query-result";
import { toSafeId } from "@/lib/safe-id";

import {
  allUnownedReaderClaimsExpired,
  projectExpiredReaderAnswers,
  readerAnswerClaimRemainder,
  readerAnswerPollDelay,
} from "./reader-answers-polling";
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

// oxlint-disable-next-line no-restricted-properties -- Claim clock is used by query fetch/interval callbacks for client recovery; it does not determine rendered SSR or hydration snapshots.
const readerPollingNow = () => Temporal.Now.instant().epochMilliseconds;
const MIN_RECOVERY_REQUEST_TIMEOUT_MS = 5000;
const TERMINAL_READER_ANSWER_STATUSES = {
  streaming: false,
  complete: true,
  failed: true,
} as const satisfies Record<
  ReaderAnswer["messages"][number]["status"],
  boolean
>;

const createReaderAnswerRuntime = (scope: string) => {
  let phase: "active" | "cancelled" = "active";
  const controllers = new Set<AbortController>();
  const ownedMessageIds = new Set<string>();
  return {
    scope,
    ownedMessageIds,
    controllers,
    busy: new Set<string>(),
    isCancelled: () => phase === "cancelled",
    reactivate: () => {
      phase = "active";
    },
    cancel: () => {
      phase = "cancelled";
      ownedMessageIds.clear();
      for (const controller of controllers) {
        controller.abort();
      }
    },
  };
};
type ReaderAnswerErrorOrigin =
  { type: "operation" } | { type: "stream"; messageId: string };
type ReaderAnswerErrors = ReadonlyMap<
  string,
  ReaderAnswerErrorOrigin & { error: APIError | ReaderAnswerFailure }
>;
type RecordReaderAnswerErrorOptions = {
  key: string;
  cause: unknown;
  origin: ReaderAnswerErrorOrigin;
  setErrors: Dispatch<SetStateAction<ReaderAnswerErrors>>;
};
const recordReaderAnswerError = ({
  key,
  cause,
  origin,
  setErrors,
}: RecordReaderAnswerErrorOptions) => {
  getAnalytics().captureError(cause);
  const error =
    APIError.is(cause) || ReaderAnswerFailure.is(cause)
      ? cause
      : new ReaderAnswerFailure({
          kind: "request",
          message: "Reader answer request failed",
        });
  switch (origin.type) {
    case "operation":
      setErrors((current) =>
        new Map(current).set(key, { type: "operation", error }),
      );
      return;
    case "stream":
      setErrors((current) =>
        new Map(current).set(key, {
          type: "stream",
          messageId: origin.messageId,
          error,
        }),
      );
      return;
    default:
      origin satisfies never;
      panic("Unknown reader answer error origin");
  }
};
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
  activateAnswer: (id: string) => void;
  setBusyAnswerIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setErrors: Dispatch<SetStateAction<ReaderAnswerErrors>>;
};
const runStreamAnswer = async (
  queryKey: DataTag<readonly unknown[], ReaderAnswer[], Error>,
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
    activateAnswer,
    setBusyAnswerIds,
    setErrors,
  }: RunStreamAnswerOptions,
) => {
  let currentAnswerId = answerId;
  const ownership: { messageId: string | null } = { messageId: null };
  const streaming = await streamReaderAnswer({
    path,
    body,
    signal,
    onEvent: (event) => {
      if (runtime.isCancelled() || signal.aborted) {
        return;
      }
      if (event.type === "started") {
        currentAnswerId = event.answerId;
        runtime.ownedMessageIds.add(event.messageId);
        ownership.messageId = event.messageId;
        activateAnswer(event.answerId);
        setBusyAnswerIds((current) => new Set([...current, event.answerId]));
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
      runtime.ownedMessageIds.delete(event.messageId);
      if (event.type === "failed") {
        setErrors((current) =>
          new Map(current).set(id, {
            type: "stream",
            messageId: event.messageId,
            error: new ReaderAnswerFailure({
              kind: "model",
              code: event.errorCode,
              message: event.message,
            }),
          }),
        );
      }
    },
  });
  if (ownership.messageId !== null) {
    runtime.ownedMessageIds.delete(ownership.messageId);
  }
  if (runtime.isCancelled() || signal.aborted) {
    return Result.ok(undefined);
  }
  if (streaming.isErr() && currentAnswerId !== null) {
    const failedId = currentAnswerId;
    if (ownership.messageId !== null) {
      recordReaderAnswerError({
        key: failedId,
        cause: streaming.error,
        origin: { type: "stream", messageId: ownership.messageId },
        setErrors,
      });
    }
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
  // An accepted stream's error is already surfaced; reconciliation may have cleared it.
  return ownership.messageId === null ? streaming : Result.ok(undefined);
};

type PerformReaderAnswerOperationOptions = Pick<
  RunStreamAnswerOptions,
  "runtime" | "queryClient" | "setBusyAnswerIds" | "setErrors"
> & {
  id: string | null;
  operation: (signal: AbortSignal) => Promise<void | Result<void, Error>>;
  enabled: boolean;
  authenticated: boolean;
  setIsCreating: Dispatch<SetStateAction<boolean>>;
};
const performReaderAnswerOperation = async (
  queryKey: DataTag<readonly unknown[], ReaderAnswer[], Error>,
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
    try: async () => await operation(controller.signal),
    catch: (cause) => cause,
  });
  runtime.controllers.delete(controller);
  runtime.busy.delete(busyKey);
  if (runtime.isCancelled() || controller.signal.aborted) {
    return;
  }
  const result = outcome.andThen((value) => value ?? Result.ok(undefined));
  if (result.isErr()) {
    recordReaderAnswerError({
      key: busyKey,
      cause: result.error,
      origin: { type: "operation" },
      setErrors,
    });
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

type ReaderAnswersRecoveryOptions = {
  decisionId: string;
  organizationId: string;
  userId: string;
  runtime: ReturnType<typeof createReaderAnswerRuntime>;
  queryClient: QueryClient;
  setErrors: Dispatch<SetStateAction<ReaderAnswerErrors>>;
};
const readerAnswersRecoveryOptions = ({
  runtime,
  queryClient,
  setErrors,
  ...key
}: ReaderAnswersRecoveryOptions) => {
  const options = readerAnswersOptions(key);
  return queryOptions({
    ...options,
    retry: false,
    networkMode: "always",
    refetchIntervalInBackground: true,
    refetchInterval: ({ state }) =>
      readerAnswerPollDelay({
        answers: state.data ?? [],
        ownedMessageIds: runtime.ownedMessageIds,
        now: readerPollingNow(),
      }),
    queryFn: async (context) => {
      const cached = queryClient.getQueryData(options.queryKey) ?? [];
      const polling = {
        answers: cached,
        ownedMessageIds: runtime.ownedMessageIds,
        now: readerPollingNow(),
      };
      const remaining = readerAnswerClaimRemainder(polling);
      const signal =
        remaining === null
          ? context.signal
          : AbortSignal.any([
              context.signal,
              // A cached deadline cannot establish whether the server finished while unmounted.
              AbortSignal.timeout(
                Math.max(MIN_RECOVERY_REQUEST_TIMEOUT_MS, remaining),
              ),
            ]);
      const read = options.queryFn;
      if (typeof read !== "function") {
        return panic("Reader answers query must own a fetch function");
      }
      const fetched = await Result.tryPromise({
        try: async () => await read({ ...context, signal }),
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new ReaderAnswerFailure({
                kind: "request",
                message: "Reader answer request failed",
              }),
      });
      const now = readerPollingNow();
      if (fetched.isOk()) {
        if (!context.signal.aborted && !runtime.isCancelled()) {
          setErrors((current) => {
            const next = new Map(current);
            for (const answer of fetched.value) {
              const failure = current.get(answer.id);
              if (failure?.type !== "stream") {
                continue;
              }
              const assistant = answer.messages.findLast(
                (message) => message.role === "assistant",
              );
              if (
                assistant?.id === failure.messageId &&
                TERMINAL_READER_ANSWER_STATUSES[assistant.status]
              ) {
                next.delete(answer.id);
              }
            }
            return next.size === current.size ? current : next;
          });
        }
        return projectExpiredReaderAnswers({
          answers: fetched.value,
          ownedMessageIds: runtime.ownedMessageIds,
          now,
        });
      }
      if (context.signal.aborted || runtime.isCancelled()) {
        return readQueryResult(fetched);
      }
      getAnalytics().captureError(fetched.error);
      // A failed recovery may time out expired claims, but must preserve newer terminal cache data.
      const current = {
        ...polling,
        answers: queryClient.getQueryData(options.queryKey) ?? cached,
        now,
      };
      const projected = projectExpiredReaderAnswers(current);
      queryClient.setQueryData(options.queryKey, projected);
      if (allUnownedReaderClaimsExpired(current)) {
        return projected;
      }
      return readQueryResult(fetched);
    },
  });
};

export type UseReaderAnswersOptions = {
  decisionId: string;
  generationMode: "enabled" | "gated";
};
export const useReaderAnswers = ({
  decisionId,
  generationMode,
}: UseReaderAnswersOptions) => {
  const user = useMaybeAuthenticatedUser();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const options = readerAnswersOptions({
    decisionId,
    organizationId: user?.activeOrganizationId ?? "",
    userId: user?.id ?? "",
  });
  const scope = `${user?.activeOrganizationId ?? "guest"}:${user?.id ?? "guest"}:${decisionId}:${generationMode}`;
  const [runtime, setRuntime] = useState(() =>
    createReaderAnswerRuntime(scope),
  );
  const [activation, setActivation] = useState<{
    id: string | null;
    revision: number;
  }>({ id: null, revision: 0 });
  const activateAnswer = (id: string) =>
    setActivation((current) => ({ id, revision: current.revision + 1 }));
  const [busyAnswerIds, setBusyAnswerIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [isCreating, setIsCreating] = useState(false);
  const [failures, setErrors] = useState<ReaderAnswerErrors>(new Map());
  const errors = new Map(
    Array.from(failures, ([id, { error }]) => [id, error] as const),
  );
  // A list refetch must not replace another thread's still-unsettled deltas.
  const query = useQuery({
    ...readerAnswersRecoveryOptions({
      decisionId,
      organizationId: user?.activeOrganizationId ?? "",
      userId: user?.id ?? "",
      runtime,
      queryClient,
      setErrors,
    }),
    enabled: user !== null && !isCreating && busyAnswerIds.size === 0,
  });
  if (runtime.scope !== scope) {
    runtime.cancel();
    setRuntime(createReaderAnswerRuntime(scope));
    setActivation({ id: null, revision: 0 });
    setBusyAnswerIds(new Set());
    setIsCreating(false);
    setErrors(new Map());
  }
  useExternalSyncEffect(() => {
    runtime.reactivate();
    return () => runtime.cancel();
  }, [runtime]);

  const perform = async (
    id: string | null,
    operation: (signal: AbortSignal) => Promise<void | Result<void, Error>>,
  ) =>
    await performReaderAnswerOperation(options.queryKey, {
      id,
      operation,
      enabled: generationMode === "enabled",
      authenticated: user !== null,
      runtime,
      queryClient,
      setIsCreating,
      setBusyAnswerIds,
      setErrors,
    });
  const run = async (input: StreamAnswerOptions) =>
    await perform(
      input.answerId,
      async (signal) =>
        await runStreamAnswer(options.queryKey, {
          ...input,
          signal,
          runtime,
          queryClient,
          decisionId,
          userId: user?.id ?? "",
          activateAnswer,
          setBusyAnswerIds,
          setErrors,
        }),
    );
  return {
    answers: query.data ?? [],
    activeAnswerId: activation.id,
    openRevision: activation.revision,
    activateAnswer,
    busyAnswerIds,
    isCreating,
    errors,
    error: errors.get("create") ?? query.error,
    isLoading: query.isLoading,
    createExplain: async (anchor: ReaderAnswerAnchor) =>
      await run({
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
    followUp: async (answerId: string, question: string) =>
      await run({
        answerId,
        path: `/${encodeURIComponent(answerId)}/messages`,
        body: { question, locale },
        regenerate: false,
      }),
    regenerate: async (answerId: string) =>
      await run({
        answerId,
        path: `/${encodeURIComponent(answerId)}/regenerate`,
        body: { locale },
        regenerate: true,
      }),
    remove: async (answerId: string) =>
      await perform(answerId, async (signal) => {
        await deleteReaderAnswer(answerId, signal);
        if (runtime.isCancelled() || signal.aborted) {
          return;
        }
        queryClient.setQueryData(
          options.queryKey,
          (current: ReaderAnswer[] | undefined) =>
            current?.filter((answer) => answer.id !== answerId),
        );
        setActivation((current) =>
          current.id === answerId
            ? { id: null, revision: current.revision }
            : current,
        );
      }),
    setVisibility: async (
      answerId: string,
      visibility: ReaderAnswer["visibility"],
    ) =>
      await perform(answerId, async (signal) => {
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
