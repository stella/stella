import { expectTypeOf } from "bun:test";

import type {
  ChatTurnFailureResponse,
  StreamChatOutcome,
  streamChat,
} from "@/api/handlers/chat/stream-chat";

type RefusedOutcome = Extract<StreamChatOutcome, { type: "refused" }>;

expectTypeOf<
  Awaited<ReturnType<typeof streamChat>>
>().toEqualTypeOf<StreamChatOutcome>();
expectTypeOf<
  RefusedOutcome["response"]
>().toEqualTypeOf<ChatTurnFailureResponse>();

export const invalidRefusal = {
  type: "refused",
  // @ts-expect-error A refusal must carry its turn failure code and retryability.
  response: new Response(),
} satisfies RefusedOutcome;
