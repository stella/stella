import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { ChatRunTarget } from "@stll/api-contract/chat-run-target";

import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import { ChatMatterPickerPending } from "@/components/chat/chat-matter-picker";
import { PromptBarPending } from "@/components/chat/docked-composer";
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
              models={null}
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

  const dockFor = (runTarget: ChatRunTarget) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={en} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <ChatComposerDock
              models={{
                activeOrganizationId: "org-1",
                threadRef: {
                  scope: "global",
                  threadId: toChatThreadId("thread-1"),
                },
                state: "ready",
                selectedModel: null,
                selectedReasoningEffort: null,
                selectModel: () => undefined,
                runTarget: {
                  type: "choice",
                  selected: runTarget,
                  select: () => undefined,
                },
              }}
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

  test("a chat on the member's computer has no web search switch: its agent always searches", () => {
    expect(dockFor({ kind: "cloud" })).toContain("lucide-globe");
    expect(
      dockFor({
        kind: "local",
        harness: "codex",
        model: "gpt-5-codex",
        approvals: "ask",
        reasoningEffort: null,
      }),
    ).not.toContain("lucide-globe");
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
