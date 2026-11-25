import type { Ref } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { createRef, useImperativeHandle } = await import("react");
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { CHAT_SEND_SENT, ChatEditorProvider, useChatEditor } =
  await import("@/components/chat-editor-provider");
const { PromptBar } = await import("./host");
const { useChatDraftStore } = await import("@/lib/chat-draft-store");
const { getChatThreadKey, toChatThreadId } =
  await import("@/lib/chat-thread-ref");

const threadRef = {
  scope: "global",
  threadId: toChatThreadId("docked-bar-attachments"),
} as const;
const threadKey = getChatThreadKey(threadRef);

afterEach(() => {
  cleanup();
  useChatDraftStore.getState().clearDraft(threadKey);
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const DockedBar = ({ ref }: { ref: Ref<ChatEditorController> }) => {
  const controller = useChatEditor({ threadRef });
  useImperativeHandle(ref, () => controller, [controller]);
  return (
    <PromptBar
      anonymized={false}
      attachmentsEnabled
      editorController={controller}
      layout="floating"
      models={null}
      onSubmit={async () => await Promise.resolve(CHAT_SEND_SENT)}
      pendingCount={0}
      status="idle"
    />
  );
};

const mount = async () => {
  const ref = createRef<ChatEditorController>();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <TooltipProvider>
            <ChatThreadTestRouter>
              <ChatEditorProvider>
                <DockedBar ref={ref} />
              </ChatEditorProvider>
            </ChatThreadTestRouter>
          </TooltipProvider>
        </FormattingProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(ref.current?.editor?.isInitialized).toBe(true));
  return { ui, client };
};

test("the docked bar shows a draft attachment inside its box, above the text and outside its scroll region", async () => {
  const { ui, client } = await mount();
  // A long paste becomes a pasted-text attachment: the real paste path.
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", "a".repeat(1501));
  fireEvent.paste(ui.getByRole("textbox"), { clipboardData });
  const chip = await waitFor(() =>
    ui.getByRole("button", { name: messages.chat.pastedText.showInTextField }),
  );

  const frame = chip.closest('[data-slot="composer-frame"]');
  const slot = chip.closest('[data-slot="composer-attachments"]');
  const region = ui.container.querySelector(
    '[data-slot="composer-text-region"]',
  );
  if (frame === null || slot === null || region === null) {
    throw new Error("Expected the chip in the frame's attachments slot");
  }
  // The frame's own slot, not chrome a surface anchors above the box.
  expect(slot.parentElement?.dataset["slot"]).toBe("composer-frame");
  expect(frame.contains(region)).toBe(true);
  expect(region.contains(chip)).toBe(false);
  // Above the text: the scroll region follows the slot, outside it.
  expect(slot.compareDocumentPosition(region)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  client.clear();
});
