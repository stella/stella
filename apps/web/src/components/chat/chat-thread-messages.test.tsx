import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import messages from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";

describe("chat thread messages", () => {
  test("shows a resendable chat message when the chat runtime errors", () => {
    const html = renderToStaticMarkup(
      <IntlProvider
        locale="en"
        // SAFETY: this mirrors the app provider boundary; locale
        // files are checked separately, while use-intl preserves
        // English literal values in the generated Messages type.
        // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
        messages={messages as Messages}
        timeZone="UTC"
      >
        <ChatThreadMessages
          approvalPendingMessageId={null}
          autoApprovedTools={new Set()}
          error={new Error("provider details must stay hidden")}
          handleAlwaysAllow={() => {}}
          handleApprove={() => {}}
          handleDeny={() => {}}
          messages={[]}
          onAskUserSubmit={() => {}}
          onResend={() => {}}
          showToolCalls={false}
          streamdownComponents={{
            a: ({ children, ...props }) => <a {...props}>{children}</a>,
          }}
        />
      </IntlProvider>,
    );

    expect(html).toContain("There was an issue sending your message.");
    expect(html).toContain("Resend");
    expect(html).not.toContain("provider details must stay hidden");
  });
});
