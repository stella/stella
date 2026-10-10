import type { ModelMessage } from "@tanstack/ai";
import { expectTypeOf } from "bun:test";

import type { ClosedTranscript } from "@/api/lib/chat/closed-transcript";

expectTypeOf<ClosedTranscript>().toExtend<ModelMessage[]>();
expectTypeOf<ModelMessage[]>().not.toExtend<ClosedTranscript>();

// @ts-expect-error Only the closure builder can mint a provider transcript.
export const unclosed: ClosedTranscript = [
  {
    role: "assistant",
    content: "Unclosed",
    toolCalls: [
      {
        id: "call",
        type: "function",
        function: { name: "save", arguments: "{}" },
      },
    ],
  },
];
