import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { PromptBarPending } from "@/components/ai-suggestions/host";
import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import { ChatMatterPickerPending } from "@/components/chat/chat-matter-picker";
import { FormattingProvider } from "@/i18n/formatting-context";
import en from "@/i18n/langs/en.json";
import { toChatThreadId } from "@/lib/chat-thread-ref";

describe("chat composer dock", () => {
  test("keeps known controls real while only the matter label is pending", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={en} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <ChatComposerDock
              leadingContext={<ChatMatterPickerPending />}
              status="pending"
              threadRef={{
                scope: "global",
                threadId: toChatThreadId("thread-1"),
              }}
            />
          </FormattingProvider>
        </IntlProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain('data-status="pending"');
    expect(markup).toContain("lucide-layers");
    expect(markup).toContain("lucide-chevron-down");
    expect(markup).toContain("lucide-globe");
    expect(markup).toContain("lucide-shield");
    expect(markup).toContain('data-slot="chat-context-ring"');
    expect(markup).not.toContain('role="status"');
    expect(markup.match(/data-slot="skeleton"/gu)).toHaveLength(1);
  });

  test("keeps the known plus control in the pending prompt row", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={en} timeZone="UTC">
          <PromptBarPending>{null}</PromptBarPending>
        </IntlProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("lucide-plus");
    expect(markup).toContain("lucide-arrow-up");
  });
});
