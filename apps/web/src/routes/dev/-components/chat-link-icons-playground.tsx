import { useState } from "react";
import type { ComponentProps } from "react";

import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import type { AskUserInput } from "@/components/chat/chat-ui-tools";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { LanguagePicker } from "@/components/language-picker";
import { createPlaygroundChatApproval } from "@/routes/dev/-components/playground-chat-approval";

const noop = () => undefined;

const ASK_USER_INPUT = {
  analysis: "[Review the source](https://example.com/source)",
  questions: [
    {
      question: "Which source should the analysis cite?",
      reason: "The answer determines the next step.",
    },
  ],
} satisfies AskUserInput;

export const ChatLinkIconsPlayground = () => {
  const [activitySession] = useState(() => ({
    reportedUnknownActivityTypes: new Set<string>(),
  }));
  const props = {
    activitySession,
    approvalPendingMessageId: null,
    messages: [
      {
        id: "visual-chat-link-icons",
        role: "assistant",
        parts: [
          {
            type: "text",
            content: [
              "Sources: [First source](https://example.com/source) and [A deliberately long source title that wraps in a narrow message column](https://example.com/second-source).",
              "",
              "Unavailable: [No icon source](https://no-icon.example/source).",
              "",
              "Bundled: [GitHub source](https://github.com/stella/stella).",
            ].join("\n"),
          },
          {
            type: "tool-call",
            name: "ask-user",
            id: "visual-chat-link-icons-ask-user",
            state: "input-complete",
            arguments: JSON.stringify(ASK_USER_INPUT),
            input: ASK_USER_INPUT,
          },
        ],
      },
    ],
    onAskUserSubmit: noop,
    onCreateDocumentResolve: noop,
    onOpenCreatedDocument: noop,
    streamdownComponents: {
      a: (linkProps: ComponentProps<"a">) => (
        <StreamdownMentionLink {...linkProps} interactive />
      ),
    },
  } satisfies ComponentProps<typeof ChatThreadMessages>;

  return (
    <ChatApprovalContext
      value={createPlaygroundChatApproval("visual-chat-link-icons")}
    >
      <section
        className="mx-auto w-full max-w-sm p-4"
        data-playground-section="chat-link-icons"
      >
        <div className="mb-4">
          <LanguagePicker />
        </div>
        <ChatThreadMessages {...props} />
      </section>
    </ChatApprovalContext>
  );
};
