import type { Ref } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import messages from "@/i18n/langs/en.json";

import type {
  ChatEditorController,
  ChatInputDraft,
} from "./chat-editor-provider";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { createRef, useImperativeHandle } = await import("react");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ChatEditorProvider, useChatEditor } =
  await import("./chat-editor-provider");
const { composerText } = await import("./chat-editor-source");
const { PromptEditorContent } = await import("./prompt-editor");
const { ChatDraftAttachmentChips } =
  await import("./chat/chat-draft-attachment-chips");
const { buildChatRequestMessage } =
  await import("@/features/chat/lib/build-chat-request-message");
const { useChatDraftStore } = await import("@/lib/chat-draft-store");
const { getChatThreadKey, toChatThreadId } =
  await import("@/lib/chat-thread-ref");

const threadRef = {
  scope: "global",
  threadId: toChatThreadId("long-paste-composer"),
} as const;
const threadKey = getChatThreadKey(threadRef);

afterEach(() => {
  cleanup();
  useChatDraftStore.getState().clearDraft(threadKey);
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ComposerHarness = ({ ref }: { ref: Ref<ChatEditorController> }) => {
  const controller = useChatEditor({ threadRef });
  useImperativeHandle(ref, () => controller, [controller]);
  return (
    <>
      <ChatDraftAttachmentChips
        files={controller.attachments}
        onExpand={controller.expandPastedText}
        onRemove={controller.removeFile}
      />
      <PromptEditorContent editor={controller.editor} />
    </>
  );
};

const mount = async () => {
  const ref = createRef<ChatEditorController>();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages}>
        <ChatEditorProvider>
          <ComposerHarness ref={ref} />
        </ChatEditorProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(ref.current?.editor?.isInitialized).toBe(true));
  const controller = () => {
    if (ref.current === null || ref.current.editor === null) {
      throw new Error("Expected a mounted composer editor");
    }
    return ref.current;
  };
  return { ui, controller, client };
};

const paste = (textbox: HTMLElement, text: string) => {
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", text);
  fireEvent.paste(textbox, { clipboardData });
};

for (const { text, attached } of [
  { text: "a".repeat(1500), attached: false },
  { text: "a".repeat(1501), attached: true },
  { text: Array.from({ length: 20 }).fill("line").join("\n"), attached: false },
  { text: Array.from({ length: 21 }).fill("line").join("\n"), attached: true },
]) {
  test(`paste with ${text.length} characters and ${text.split("\n").length} lines ${attached ? "attaches" : "stays inline"}`, async () => {
    const { ui, controller, client } = await mount();
    paste(ui.getByRole("textbox"), text);
    if (attached) {
      await waitFor(() => expect(controller().attachments).toHaveLength(1));
      expect(controller().attachments.at(0)).toMatchObject({
        type: "pasted_text",
        text,
      });
      expect(controller().editor?.state.doc.textContent).toBe("");
      expect(controller().canSubmit).toBe(true);
      expect(
        ui.getByRole("button", {
          name: messages.chat.pastedText.showInTextField,
        }),
      ).toBeDefined();
    } else {
      expect(controller().attachments).toEqual([]);
      expect(controller().editor?.getText({ blockSeparator: "\n" })).toBe(text);
    }
    client.clear();
  });
}

test("expanding a pasted chip inserts exact text at the current selection and removes it", async () => {
  const text = ` \t<p>quoted &amp; text</p>\r\n${"x".repeat(1501)}\n\n trailing \r`;
  const { ui, controller, client } = await mount();
  act(() => controller().setContent(composerText("BeforeAfter")));
  paste(ui.getByRole("textbox"), text);
  act(() => controller().editor?.commands.setTextSelection(7));
  fireEvent.click(
    ui.getByRole("button", { name: messages.chat.pastedText.showInTextField }),
  );
  expect(controller().editor?.state.doc.textContent).toBe(`Before${text}After`);
  await waitFor(() => expect(controller().attachments).toEqual([]));
  expect(
    ui.queryByRole("button", {
      name: messages.chat.pastedText.showInTextField,
    }),
  ).toBeNull();
  expect(useChatDraftStore.getState().getDraft(threadKey)?.attachments).toEqual(
    [],
  );
  client.clear();
});

test("expanded pasted chips preserve arbitrary text byte for byte", async () => {
  await assertProperty(
    "expanded pasted chips preserve arbitrary text byte for byte",
    fc.asyncProperty(fc.string(), async (source) => {
      // Every generated input reaches the chip path; literal CRLF, tabs, and
      // leading/trailing whitespace challenge the editor's parsing boundary.
      const text = ` \t\r\n${source}\r\n${"x".repeat(1501)}\n `;
      const { ui, controller, client } = await mount();
      try {
        paste(ui.getByRole("textbox"), text);
        await waitFor(() => expect(controller().attachments).toHaveLength(1));
        fireEvent.click(
          ui.getByRole("button", {
            name: messages.chat.pastedText.showInTextField,
          }),
        );
        expect(controller().editor?.state.doc.textContent).toBe(text);
        expect(controller().attachments).toEqual([]);
      } finally {
        ui.unmount();
        client.clear();
        useChatDraftStore.getState().clearDraft(threadKey);
      }
    }),
    { numRuns: 25 },
  );
});

test("removing a pasted attachment preserves the typed draft", async () => {
  const { ui, controller, client } = await mount();
  act(() => controller().setContent(composerText("Existing question")));
  paste(ui.getByRole("textbox"), "a".repeat(1501));
  fireEvent.click(ui.getByRole("button", { name: messages.common.remove }));
  expect(controller().attachments).toEqual([]);
  expect(controller().editor?.state.doc.textContent).toBe("Existing question");
  expect(controller().canSubmit).toBe(true);
  client.clear();
});

test("sending keeps typed content and exact pasted attachment text in the request", async () => {
  const text = ` \r\n${"a".repeat(1501)}\t\n `;
  const { ui, controller, client } = await mount();
  act(() => controller().setContent(composerText("Review this passage")));
  paste(ui.getByRole("textbox"), text);
  const sent: ChatInputDraft[] = [];
  await act(async () =>
    controller().submit((draft) => {
      sent.push(draft);
    }),
  );
  const draft = sent.at(0);
  if (draft === undefined) {
    throw new Error("Expected the composer to submit its draft");
  }
  expect(await buildChatRequestMessage(draft)).toMatchObject({
    content: [
      { type: "text", content: "<p>Review this passage</p>" },
      { type: "text", content: text, metadata: { type: "pasted_text" } },
    ],
  });
  expect(controller().attachments).toEqual([]);
  expect(controller().editor?.isEmpty).toBe(true);
  expect(useChatDraftStore.getState().getDraft(threadKey)).toBeNull();
  client.clear();
});

test("a pasted chip alone submits without an empty prompt part", async () => {
  const text = "a".repeat(1501);
  const { ui, controller, client } = await mount();
  paste(ui.getByRole("textbox"), text);
  const sent: ChatInputDraft[] = [];
  await act(async () =>
    controller().submit((draft) => {
      sent.push(draft);
    }),
  );
  const draft = sent.at(0);
  if (draft === undefined) {
    throw new Error("Expected an attachment-only draft to submit");
  }
  expect(draft.html).toBe("");
  expect(await buildChatRequestMessage(draft)).toMatchObject({
    content: [
      { type: "text", content: text, metadata: { type: "pasted_text" } },
    ],
  });
  expect(controller().canSubmit).toBe(false);
  client.clear();
});

test("a failed send restores typed text and pasted chips for an identical retry", async () => {
  const text = ` ${"a".repeat(1501)}\r\n\t `;
  const { ui, controller, client } = await mount();
  act(() => controller().setContent(composerText("Review this passage")));
  paste(ui.getByRole("textbox"), text);
  const originalAttachments = controller().attachments;
  const originalDoc = controller().editor?.getJSON();
  const sent: ChatInputDraft[] = [];
  await act(async () => {
    const failure = await rejectionOf(
      controller().submit((draft) => {
        sent.push(draft);
        throw new Error("Send unavailable");
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error && failure.message).toBe(
      "Send unavailable",
    );
  });
  expect(controller().attachments).toEqual(originalAttachments);
  expect(controller().editor?.getJSON()).toEqual(originalDoc);
  expect(useChatDraftStore.getState().getDraft(threadKey)?.attachments).toEqual(
    originalAttachments,
  );
  await act(async () =>
    controller().submit((draft) => {
      sent.push(draft);
    }),
  );
  expect(sent).toHaveLength(2);
  expect(sent.at(1)).toEqual(sent.at(0));
  client.clear();
});
