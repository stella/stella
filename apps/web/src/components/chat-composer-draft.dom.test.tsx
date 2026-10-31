import type { Ref } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import messages from "@/i18n/langs/en.json";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { unregisterDomEnvironment } from "@/test-dom-environment";

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
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { CHAT_SEND_KEPT, CHAT_SEND_SENT, ChatEditorProvider, useChatEditor } =
  await import("./chat-editor-provider");
const { PromptEditorContent } = await import("./prompt-editor");
const { ChatDraftAttachmentChips } =
  await import("./chat/chat-draft-attachment-chips");
const { useChatDraftStore } = await import("@/lib/chat-draft-store");
const { getChatThreadKey, toChatThreadId } =
  await import("@/lib/chat-thread-ref");

const firstThread = {
  scope: "global",
  threadId: toChatThreadId("draft-thread-first"),
} as const satisfies ChatThreadRef;
const secondThread = {
  scope: "global",
  threadId: toChatThreadId("draft-thread-second"),
} as const satisfies ChatThreadRef;
const firstKey = getChatThreadKey(firstThread);
const secondKey = getChatThreadKey(secondThread);

const clients: InstanceType<typeof QueryClient>[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients) {
    client.clear();
  }
  clients.length = 0;
  useChatDraftStore.setState({ draftsByThreadKey: {} });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const ComposerHarness = ({
  ref,
  threadRef,
}: {
  ref: Ref<ChatEditorController>;
  threadRef: ChatThreadRef;
}) => {
  const controller = useChatEditor({ threadRef });
  useImperativeHandle(ref, () => controller, [controller]);
  return (
    <div onDrop={controller.handleDrop}>
      <ChatDraftAttachmentChips
        files={controller.attachments}
        onExpand={controller.expandPastedText}
        onRemove={controller.removeFile}
      />
      <PromptEditorContent editor={controller.editor} />
    </div>
  );
};

/** One composer, rebindable to another thread the way a route change does. */
const mount = async (threadRef: ChatThreadRef) => {
  const ref = createRef<ChatEditorController>();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  const tree = (target: ChatThreadRef) => (
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages}>
        <ChatThreadTestRouter>
          <ChatEditorProvider>
            <ComposerHarness ref={ref} threadRef={target} />
          </ChatEditorProvider>
        </ChatThreadTestRouter>
      </IntlProvider>
    </QueryClientProvider>
  );
  const ui = render(tree(threadRef));
  await waitFor(() => expect(ref.current?.editor?.isInitialized).toBe(true));
  const controller = () => {
    if (!ref.current?.editor) {
      throw new Error("Expected a mounted composer editor");
    }
    return ref.current;
  };
  const switchTo = (target: ChatThreadRef) => {
    act(() => {
      ui.rerender(tree(target));
    });
  };
  return { ui, controller, switchTo };
};

/** A keystroke burst: a real doc change that schedules the debounced mirror write. */
const type = (controller: ChatEditorController, text: string) => {
  act(() => {
    controller.editor?.chain().focus("end").insertContent(text).run();
  });
};

const dropFile = (textbox: HTMLElement, file: File) => {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  fireEvent.drop(textbox, { dataTransfer });
};

const storedText = (threadKey: string) =>
  useChatDraftStore
    .getState()
    .getDraft(threadKey)
    ?.doc.content?.flatMap((block) => block.content ?? [])
    .map((inline) => inline.text ?? "")
    .join("");

test("switching threads mid-typing keeps both drafts with their own attachments", async () => {
  const { ui, controller, switchTo } = await mount(firstThread);
  const brief = new File(["brief"], "brief.txt", { type: "text/plain" });
  dropFile(ui.getByRole("textbox"), brief);
  await waitFor(() => expect(controller().attachments).toHaveLength(1));
  type(controller(), "Alpha question");
  // Still inside the debounce window: the store has not seen the text yet,
  // so only the thread-switch flush can save it.
  expect(storedText(firstKey)).toBe("");

  switchTo(secondThread);
  expect(storedText(firstKey)).toBe("Alpha question");
  expect(controller().editor?.getText()).toBe("");
  expect(controller().attachments).toEqual([]);

  type(controller(), "Beta question");
  expect(storedText(secondKey)).toBeUndefined();

  switchTo(firstThread);
  await waitFor(() =>
    expect(controller().editor?.getText()).toBe("Alpha question"),
  );
  // The restored attachments are the ones the store saved for this thread.
  expect(
    useChatDraftStore
      .getState()
      .getDraft(firstKey)
      ?.attachments.map((item) => item.id),
  ).toEqual(controller().attachments.map((item) => item.id));
  expect(controller().attachments).toMatchObject([
    { type: "file", filename: "brief.txt" },
  ]);
  expect(storedText(secondKey)).toBe("Beta question");
  expect(useChatDraftStore.getState().getDraft(secondKey)?.attachments).toEqual(
    [],
  );

  switchTo(secondThread);
  await waitFor(() =>
    expect(controller().editor?.getText()).toBe("Beta question"),
  );
  expect(controller().attachments).toEqual([]);
});

test("a draft typed just before the composer unmounts is there when it mounts again", async () => {
  const first = await mount(firstThread);
  type(first.controller(), "Keep this wording");
  expect(storedText(firstKey)).toBeUndefined();
  first.ui.unmount();

  expect(storedText(firstKey)).toBe("Keep this wording");
  const second = await mount(firstThread);
  expect(second.controller().editor?.getText()).toBe("Keep this wording");
});

test("a failed send restores typed text and file attachments once, for an identical retry", async () => {
  const { ui, controller } = await mount(firstThread);
  dropFile(
    ui.getByRole("textbox"),
    new File(["one"], "one.txt", { type: "text/plain" }),
  );
  dropFile(
    ui.getByRole("textbox"),
    new File(["two"], "two.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(controller().attachments).toHaveLength(2));
  type(controller(), "Compare both files");
  const originalAttachments = controller().attachments;
  const originalDoc = controller().editor?.getJSON();

  const sent: ChatInputDraft[] = [];
  await act(async () => {
    const failure = await rejectionOf(
      controller().submit((draft) => {
        sent.push(draft);
        // Cleared while the request is in flight, so a retry cannot double up.
        expect(controller().editor?.isEmpty).toBe(true);
        expect(useChatDraftStore.getState().getDraft(firstKey)).toBeNull();
        throw new Error("Send unavailable");
      }),
    );
    expect(failure instanceof Error && failure.message).toBe(
      "Send unavailable",
    );
  });

  expect(controller().editor?.getJSON()).toEqual(originalDoc);
  expect(controller().editor?.getText()).toBe("Compare both files");
  expect(controller().attachments).toEqual(originalAttachments);
  expect(Object.keys(useChatDraftStore.getState().draftsByThreadKey)).toEqual([
    firstKey,
  ]);
  expect(useChatDraftStore.getState().getDraft(firstKey)).toMatchObject({
    attachments: originalAttachments,
    doc: originalDoc,
  });
  expect(
    ui.getAllByRole("button", { name: messages.common.remove }),
  ).toHaveLength(2);

  await act(async () =>
    controller().submit((draft) => {
      sent.push(draft);
      return CHAT_SEND_SENT;
    }),
  );
  expect(sent).toHaveLength(2);
  expect(sent.at(1)).toEqual(sent.at(0));
  expect(useChatDraftStore.getState().getDraft(firstKey)).toBeNull();
});

// A send that declines (no AI key, a model choice that did not save, a busy
// thread) reports `kept` instead of throwing: the draft comes back without an
// error toast, exactly as typed.
test("a send that keeps the draft restores it in place", async () => {
  const { ui, controller } = await mount(firstThread);
  dropFile(
    ui.getByRole("textbox"),
    new File(["memo"], "memo.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(controller().attachments).toHaveLength(1));
  type(controller(), "Check the notice period");
  const originalAttachments = controller().attachments;
  const originalDoc = controller().editor?.getJSON();

  await act(async () =>
    controller().submit(() => {
      expect(controller().editor?.isEmpty).toBe(true);
      return CHAT_SEND_KEPT;
    }),
  );

  expect(controller().editor?.getJSON()).toEqual(originalDoc);
  expect(controller().attachments).toEqual(originalAttachments);
  expect(useChatDraftStore.getState().getDraft(firstKey)).toMatchObject({
    attachments: originalAttachments,
    doc: originalDoc,
  });
  expect(controller().canSubmit).toBe(true);
});

test("a send that went out leaves the composer and the stored draft empty", async () => {
  const { controller } = await mount(firstThread);
  type(controller(), "Send this one");

  await act(async () => controller().submit(() => CHAT_SEND_SENT));

  expect(controller().editor?.isEmpty).toBe(true);
  expect(useChatDraftStore.getState().getDraft(firstKey)).toBeNull();
  expect(controller().canSubmit).toBe(false);
});

test("a draft kept for a materialized thread is restored under that thread only", async () => {
  const { controller } = await mount(firstThread);
  type(controller(), "Start the review");

  await act(async () =>
    controller().submit(() => ({ kind: "kept", restoreThreadKey: secondKey })),
  );

  expect(Object.keys(useChatDraftStore.getState().draftsByThreadKey)).toEqual([
    secondKey,
  ]);
  expect(storedText(secondKey)).toBe("Start the review");
});

const insertHardBreak = (controller: ChatEditorController) => {
  act(() => {
    controller.editor?.chain().focus("end").setHardBreak().run();
  });
};

const insertBlankText =
  (text: string) => (controller: ChatEditorController) => {
    act(() => {
      controller.editor
        ?.chain()
        .focus("end")
        .insertContent({ type: "text", text })
        .run();
    });
  };

// The editor's own emptiness check counts spaces and a line break as content,
// so these drafts used to go out and reach the provider as an empty message.
test.each([
  ["spaces", insertBlankText("   ")],
  ["a line break", insertHardBreak],
  ["the spaces left after removing chips", insertBlankText("   ")],
])(
  "a draft of only %s is not sent and stays in the composer",
  async (_label, fill) => {
    const { controller } = await mount(firstThread);
    fill(controller());
    // The fault boundary: the editor itself does not call this draft empty.
    expect(controller().editor?.isEmpty).toBe(false);
    const originalDoc = controller().editor?.getJSON();
    const sent: ChatInputDraft[] = [];

    await act(async () =>
      controller().submit((draft) => {
        sent.push(draft);
        return CHAT_SEND_SENT;
      }),
    );

    expect(sent).toEqual([]);
    expect(controller().editor?.getJSON()).toEqual(originalDoc);
  },
);

test("a draft of chips alone is sent: a quoted passage is content", async () => {
  const { controller } = await mount(firstThread);
  act(() => {
    controller()
      .editor?.chain()
      .focus("end")
      .insertContent([
        {
          type: "pastedText",
          attrs: { label: "1 Afs 2/2020", source: "paste", text: "Quoted" },
        },
        { type: "text", text: " " },
      ])
      .run();
  });
  const sent: ChatInputDraft[] = [];

  await act(async () =>
    controller().submit((draft) => {
      sent.push(draft);
      return CHAT_SEND_SENT;
    }),
  );

  expect(sent).toHaveLength(1);
  expect(sent[0]?.html).toContain("Quoted");
});
