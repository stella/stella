import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { ConversationScrollButton } from "@/components/ai-elements/conversation";
import { StickToBottomContext } from "@/hooks/use-stick-to-bottom";
import messages from "@/i18n/langs/ar.json";

const STICK_TO_BOTTOM = {
  contentRef: () => {},
  isAtBottom: false,
  isScrollable: true,
  scrollElementRef: { current: null },
  scrollRef: () => {},
  scrollToBottom: () => {},
};

test("announces the scroll action in the active locale", () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="ar" messages={messages} timeZone="UTC">
      <StickToBottomContext value={STICK_TO_BOTTOM}>
        <ConversationScrollButton />
      </StickToBottomContext>
    </IntlProvider>,
  );

  expect(html).toContain('aria-label="التمرير إلى الأسفل"');
  expect(html).not.toContain('aria-label="Scroll to bottom"');
});

test("renders nothing at the bottom or outside a conversation", () => {
  const atBottom = renderToStaticMarkup(
    <IntlProvider locale="ar" messages={messages} timeZone="UTC">
      <StickToBottomContext value={{ ...STICK_TO_BOTTOM, isAtBottom: true }}>
        <ConversationScrollButton />
      </StickToBottomContext>
    </IntlProvider>,
  );
  const outside = renderToStaticMarkup(
    <IntlProvider locale="ar" messages={messages} timeZone="UTC">
      <ConversationScrollButton />
    </IntlProvider>,
  );

  expect(atBottom).toBe("");
  expect(outside).toBe("");
});
