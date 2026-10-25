import { infiniteQueryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

type AnswerRevisionHistoryOptions = Parameters<
  typeof chatKeys.answerHistory
>[0];

export const answerRevisionHistoryOptions = (
  input: AnswerRevisionHistoryOptions,
) =>
  resourceQueryOptions(
    infiniteQueryOptions({
      queryKey: chatKeys.answerHistory(input),
      initialPageParam: stringCursorSeed(),
      queryFn: async ({ pageParam, signal }) =>
        unwrapEden(
          await api.chat
            .threads({ threadId: input.threadId })
            .messages({ messageId: input.messageId })
            .revisions.get({
              fetch: { signal },
              query: {
                limit: 20,
                ...(pageParam === undefined ? {} : { cursor: pageParam }),
              },
            }),
        ),
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      retry: false,
    }),
    {
      resources: [RESOURCE_TYPE.CHAT_MESSAGE],
      scope: { type: "organization" },
    },
  );
