import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { ConversationScrollButton } from "@/components/ai-elements/conversation";
import { SuggestedFollowupChips } from "@/features/chat/components/suggested-followup-chips";
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

test("keeps the inline scroll action outside the suggested-followups group", () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="ar" messages={messages} timeZone="UTC">
      <StickToBottomContext value={STICK_TO_BOTTOM}>
        <SuggestedFollowupChips onSelect={() => {}} prompts={["لخّص النتيجة"]} />
      </StickToBottomContext>
    </IntlProvider>,
  );

  const scrollActionIndex = html.indexOf('aria-label="التمرير إلى الأسفل"');
  const suggestedGroupIndex = html.indexOf(
    `aria-label="${messages.chat.suggestedFollowupsLabel}"`,
  );
  // The group holds only buttons and spans, so its first closing `</div>`
  // is the group's own.
  const suggestedGroupEnd = html.indexOf("</div>", suggestedGroupIndex);

  expect(suggestedGroupIndex).toBeGreaterThan(-1);
  expect(scrollActionIndex).toBeGreaterThan(suggestedGroupEnd);
});

test("reserves the inline scroll slot while the action is hidden", () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="ar" messages={messages} timeZone="UTC">
      <StickToBottomContext value={{ ...STICK_TO_BOTTOM, isAtBottom: true }}>
        <SuggestedFollowupChips onSelect={() => {}} prompts={["لخّص النتيجة"]} />
      </StickToBottomContext>
    </IntlProvider>,
  );

  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("invisible");
  expect(html).not.toContain('aria-label="التمرير إلى الأسفل"');
  expect(html).toContain(
    `aria-label="${messages.chat.suggestedFollowupsLabel}"`,
  );
});
