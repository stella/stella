import type { ComponentProps } from "react";

import { CHAT_CONTINUATION_REJECTED_ERROR_CODE } from "@stll/api-contract";

import { ChatErrorMessage } from "@/components/chat/chat-thread-messages";
import { toAPIError } from "@/lib/errors/api";

const rejectedContinuation = {
  error: toAPIError({
    status: 400,
    value: {
      code: CHAT_CONTINUATION_REJECTED_ERROR_CODE,
      message: "The continuation did not match the stored chat state.",
    },
  }),
  isGenerating: false,
  onResend: () => undefined,
} satisfies ComponentProps<typeof ChatErrorMessage>;

export const ChatContinuationErrorPlayground = () => (
  <div className="mx-auto w-full max-w-2xl p-6">
    <ChatErrorMessage {...rejectedContinuation} />
  </div>
);
