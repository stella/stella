import { queryOptions } from "@tanstack/react-query";
import { Result } from "better-result";

import type {
  ReaderAnswer,
  ReaderAnswerStreamEvent,
} from "@stll/api-contract/reader-answers";
import { READER_ANSWER_DEADLINE_MS } from "@stll/api-contract/reader-answers";
import { fetchWithTimeout } from "@stll/fetch";

import { api } from "@/lib/api";
import { getApiRequestHeaders } from "@/lib/api-request-context";
import { apiUrl } from "@/lib/api-url";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";
import { toSafeId } from "@/lib/safe-id";

import {
  consumeReaderAnswerStream,
  ReaderAnswerFailure,
} from "./reader-answers.logic";

type ReaderAnswersKey = {
  decisionId: string;
  organizationId: string;
  userId: string;
};
export const readerAnswersOptions = ({
  decisionId,
  organizationId,
  userId,
}: ReaderAnswersKey) =>
  queryOptions({
    queryKey: ["reader-answers", organizationId, userId, decisionId],
    queryFn: async ({ signal }): Promise<ReaderAnswer[]> => {
      const queryDecisionId = toSafeId<"caseLawDecision">(decisionId);
      const answers: ReaderAnswer[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const pageRequest = {
          query: {
            decisionId: queryDecisionId,
            limit: 50,
            ...(cursor === undefined ? {} : { cursor }),
          },
          fetch: { signal },
        };
        const fetched = await Result.tryPromise(async () =>
          unwrapApiResponse(
            // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- The next page cursor is known only after the preceding response.
            await api.reader.answers.get(pageRequest),
          ),
        );
        if (fetched.isErr()) {
          // A refusal is an APIError and passes through; a TypeError is the
          // network failing.
          const { cause } = fetched.error;
          return readQueryResult(
            Result.err(
              cause instanceof TypeError || !(cause instanceof Error)
                ? new ReaderAnswerFailure({
                    kind: "request",
                    message: "Reader answer request failed",
                    cause,
                  })
                : cause,
            ),
          );
        }
        const page = fetched.value;
        answers.push(...page.items);
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) {
            return readQueryResult(
              Result.err(
                new ReaderAnswerFailure({
                  kind: "protocol",
                  message: "Reader answer pagination did not advance",
                }),
              ),
            );
          }
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      return answers;
    },
    staleTime: 0,
  });

type StreamReaderAnswerOptions = {
  path: string;
  body: object;
  signal: AbortSignal;
  onEvent: (event: ReaderAnswerStreamEvent) => void;
};
export const streamReaderAnswer = async ({
  path,
  body,
  signal,
  onEvent,
}: StreamReaderAnswerOptions) => {
  const fetched = await Result.tryPromise(
    async () =>
      await fetchWithTimeout(apiUrl(`/reader/answers${path}`), {
        method: "POST",
        credentials: "include",
        signal,
        timeout: { type: "idle", ms: READER_ANSWER_DEADLINE_MS },
        headers: {
          ...getApiRequestHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
  );
  if (fetched.isErr()) {
    return Result.err(fetched.error);
  }
  const response = fetched.value;
  if (!response.ok) {
    const decoded = await Result.tryPromise(
      async (): Promise<unknown> => await response.json(),
    );
    if (decoded.isErr()) {
      return Result.err(decoded.error);
    }
    return Result.err(
      toAPIError({ status: response.status, value: decoded.value }),
    );
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    const cancelled = await Result.tryPromise(
      async () => await response.body?.cancel(),
    );
    if (cancelled.isErr()) {
      return Result.err(cancelled.error);
    }
    return Result.err(
      new ReaderAnswerFailure({
        kind: "protocol",
        message: "Missing reader answer stream",
      }),
    );
  }
  return await consumeReaderAnswerStream({
    body: response.body,
    signal,
    onEvent,
  });
};

export const deleteReaderAnswer = async (
  answerId: string,
  signal: AbortSignal,
) =>
  unwrapApiResponse(
    await api.reader
      .answers({ answerId: toSafeId<"legalReaderAnswer">(answerId) })
      .delete({ fetch: { signal } }),
  );
export const changeReaderAnswerVisibility = async (
  answerId: string,
  visibility: ReaderAnswer["visibility"],
  signal: AbortSignal,
) =>
  unwrapApiResponse(
    await api.reader
      .answers({ answerId: toSafeId<"legalReaderAnswer">(answerId) })
      .patch({ visibility }, { fetch: { signal } }),
  );
