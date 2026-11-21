import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  ChatContextMeter,
  type ChatContextUsage,
} from "@/components/chat/chat-context-meter";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

const render = (usage: ChatContextUsage) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ChatContextMeter status="ready" usage={usage} />
      </FormattingProvider>
    </IntlProvider>,
  );

const label = (percent: number) =>
  messages.chat.contextMeter.triggerLabel.replace("{percent}", () =>
    String(percent),
  );

/** An estimate of a quarter of the trigger, as the next send would carry. */
const ESTIMATE: ChatContextUsage = {
  estimatedTokens: 16_000,
  triggerTokens: 64_000,
  cacheStableTokens: 6000,
  summarizedMessageCount: 0,
  breakdown: {
    promptTokens: 4000,
    toolTokens: 2000,
    summaryTokens: 0,
    attachmentTokens: 0,
    conversationTokens: 10_000,
  },
};

describe("the composer's context meter", () => {
  test("shows stella's estimate for a thread on stella's own models", () => {
    const html = render(ESTIMATE);
    expect(html).toContain(`aria-label="${label(25)}"`);
    expect(html).toContain('data-source="estimate"');
  });

  test("shows what the harness reported for a thread on the member's computer, against its window", () => {
    const html = render({
      ...ESTIMATE,
      reported: { usedTokens: 192_000, windowTokens: 200_000 },
    });
    // 96% of the harness's window, not the estimate's 25% of the trigger.
    expect(html).toContain(`aria-label="${label(96)}"`);
    expect(html).toContain('data-source="reported"');
    expect(html).toContain("text-destructive");
  });
});
