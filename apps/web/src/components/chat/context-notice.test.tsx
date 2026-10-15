import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { ChatMessageMetadata } from "@/components/chat/chat-ui-tools";
import { ContextNotice } from "@/components/chat/context-notice";
import messages from "@/i18n/langs/en.json";

const render = (metadata: ChatMessageMetadata | undefined) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ContextNotice metadata={metadata} />
    </IntlProvider>,
  );

describe("an answer's context notice", () => {
  test("says that earlier history was left out of the answer's context", () => {
    const markup = render({ contextNotice: { type: "history-trimmed" } });

    expect(markup).toContain('role="status"');
    expect(markup).toContain(messages.chat.historyTrimmed);
  });

  test("stays hidden on an answer whose context left nothing out", () => {
    expect(render(undefined)).toBe("");
    expect(render({})).toBe("");
  });
});
