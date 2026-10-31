import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ChatThreadMessages } =
  await import("@/components/chat/chat-thread-messages");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { ChatApprovalContext } =
  await import("@/components/chat/chat-approval-context");
const { testChatApprovalContextValue } =
  await import("@/components/chat/chat-approval-context.test-fixtures");
const { ChatMattersContext } =
  await import("@/components/chat/chat-matters-context");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const user = {
  id: "question",
  role: "user",
  parts: [{ type: "text", content: "Review the sources" }],
} satisfies ChatUIMessage;
const tool = {
  type: "tool-call",
  id: "search",
  name: "read_document",
  arguments: '{"documentId":"document-one"}',
  state: "input-complete",
} as const satisfies ChatUIMessage["parts"][number];
const runningTiming = {
  status: "running",
  durationMs: 0,
  elapsedMs: 0,
  startedAt: "2026-01-01T00:00:00.000Z",
  observedAt: "2026-01-01T00:00:00.000Z",
} as const;

type ThreadProps = Pick<
  ComponentProps<typeof ChatThreadMessages>,
  "messages" | "isGenerating" | "error" | "stickyUserMessages"
>;
const View = (props: ThreadProps) => (
  <ChatThreadTestRouter>
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatMattersContext
          value={{ createDocumentMattersView: { type: "empty" } }}
        >
          <ChatApprovalContext value={testChatApprovalContextValue}>
            <FormattingProvider locale="en" timeZone="UTC">
              <ChatEditorProvider>
                <ChatThreadMessages
                  {...props}
                  activitySession={{
                    reportedUnknownActivityTypes: new Set<string>(),
                  }}
                  approvalPendingMessageId={null}
                  onAskUserSubmit={() => {}}
                  onCreateDocumentResolve={() => {}}
                  onOpenCreatedDocument={() => {}}
                  streamdownComponents={{
                    a: ({ children, ...anchorProps }) => (
                      <a {...anchorProps}>{children}</a>
                    ),
                  }}
                  showToolCalls
                />
              </ChatEditorProvider>
            </FormattingProvider>
          </ChatApprovalContext>
        </ChatMattersContext>
      </IntlProvider>
    </QueryClientProvider>
  </ChatThreadTestRouter>
);

for (const stickyUserMessages of [false, true]) {
  for (const { ending } of [
    { ending: "finished" },
    { ending: "stopped" },
    { ending: "failed" },
  ] as const) {
    test(`one live owner covers a ${ending} turn (sticky: ${stickyUserMessages})`, () => {
      const view = render(
        <View
          messages={[user]}
          isGenerating
          stickyUserMessages={stickyUserMessages}
        />,
      );
      const assertLive = (label: string) => {
        const lines = view.container.querySelectorAll(
          "[data-turn-live-status]",
        );
        expect(lines).toHaveLength(1);
        expect(lines.item(0).textContent).toContain(label);
        expect(
          view.container.querySelectorAll('[data-slot="loader"]'),
        ).toHaveLength(1);
        expect(
          [
            ...view.container.querySelectorAll(
              '[data-status="running"], .animate-spin',
            ),
          ].filter((node) => node.closest("[data-turn-live-status]") === null),
        ).toHaveLength(0);
        expect(
          view.container.querySelectorAll(
            "[data-chat-turn-duration], [data-tool-duration], [data-process-duration]",
          ),
        ).toHaveLength(0);
      };
      assertLive(messages.chat.thinking);
      const assistant = {
        id: "answer",
        role: "assistant",
        parts: [tool],
        metadata: { turnTiming: runningTiming },
      } satisfies ChatUIMessage;
      view.rerender(
        <View
          messages={[user, assistant]}
          isGenerating
          stickyUserMessages={stickyUserMessages}
        />,
      );
      assertLive(messages.chat.tool.read_document);
      view.rerender(
        <View
          messages={[
            user,
            { ...assistant, parts: [{ ...tool, state: "approval-requested" }] },
          ]}
          isGenerating
          stickyUserMessages={stickyUserMessages}
        />,
      );
      assertLive(messages.chat.turnStatus.waitingForApproval);
      const completed = { ...tool, state: "complete" } as const;
      view.rerender(
        <View
          messages={[user, { ...assistant, parts: [completed] }]}
          isGenerating
          stickyUserMessages={stickyUserMessages}
        />,
      );
      assertLive(messages.chat.analyzingSources);
      const writing = {
        ...assistant,
        parts: [completed, { type: "text", content: "The sources agree." }],
      } satisfies ChatUIMessage;
      view.rerender(
        <View
          messages={[user, writing]}
          isGenerating
          stickyUserMessages={stickyUserMessages}
        />,
      );
      assertLive(messages.chat.turnStatus.writing);
      if (ending !== "finished") {
        view.rerender(
          <View
            messages={[user, assistant]}
            isGenerating
            stickyUserMessages={stickyUserMessages}
          />,
        );
        assertLive(messages.chat.tool.read_document);
      }
      const finished = {
        ...writing,
        parts:
          ending === "finished" ? writing.parts : [{ ...tool, state: "error" }],
        metadata: { turnTiming: { status: "finished", durationMs: 5000 } },
      } satisfies ChatUIMessage;
      const terminalProps = {
        messages: [user, finished],
        isGenerating: ending === "failed",
        error: ending === "failed" ? new Error("provider failed") : undefined,
        stickyUserMessages,
      } satisfies ThreadProps;
      view.rerender(<View {...terminalProps} />);
      expect(
        view.container.querySelectorAll(
          '[data-turn-live-status], [data-slot="loader"], [data-status="running"]',
        ),
      ).toHaveLength(0);
      expect(view.container.textContent).toContain("Worked for 5s");
      expect(
        view.container.querySelectorAll("[data-tool-duration]"),
      ).toHaveLength(1);
      expect(
        view.container.querySelectorAll("[data-process-duration]"),
      ).toHaveLength(1);
      expect(
        view.container.querySelector("[data-tool-duration]")?.textContent,
      ).toMatch(/^\d+s$/u);
      expect(
        view.container.querySelector("[data-process-duration]")?.textContent,
      ).toMatch(/^\d+s$/u);

      // Reload has the persisted turn duration; per-step timings only exist for
      // work this view observed and must not be invented during hydration.
      view.unmount();
      const reloaded = render(<View {...terminalProps} />);
      expect(
        reloaded.container.querySelectorAll(
          '[data-turn-live-status], [data-slot="loader"], [data-status="running"]',
        ),
      ).toHaveLength(0);
      expect(reloaded.container.textContent).toContain("Worked for 5s");
      expect(
        reloaded.container.querySelectorAll(
          "[data-tool-duration], [data-process-duration]",
        ),
      ).toHaveLength(0);

      if (ending === "finished") {
        reloaded.rerender(
          <View
            messages={[user, finished, { ...user, id: "next-question" }]}
            isGenerating
            stickyUserMessages={stickyUserMessages}
          />,
        );
        expect(
          reloaded.container.querySelectorAll("[data-turn-live-status]"),
        ).toHaveLength(1);
        expect(
          reloaded.container.querySelector("[data-turn-live-status]")
            ?.textContent,
        ).toContain(messages.chat.thinking);
        expect(
          reloaded.container.querySelectorAll("[data-chat-turn-duration]"),
        ).toHaveLength(1);
      }
    });
  }
}
