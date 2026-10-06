import type { PropsWithChildren, Ref } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

GlobalRegistrator.register({ url: "https://app.example.test/chat" });
const previousApiUrl = process.env["VITE_API_URL"];
process.env["VITE_API_URL"] ??= "https://api.example.test";
const { createRef, useImperativeHandle } = await import("react");
const { act, cleanup, render, waitFor } =
  await import("@testing-library/react");
const { EditorContent } = await import("@tiptap/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ChatEditorProvider, ChatSubmitPreservedError, useChatEditor } =
  await import("@/components/chat-editor-provider");
const { createChatComposerDocument } =
  await import("@/components/chat-editor-markdown.logic");
const { composerText } = await import("@/components/chat-editor-source");
const { createChatDraftState, useChatDraftStore } =
  await import("@/lib/chat-draft-store");
const { getChatThreadKey, toChatThreadId } =
  await import("@/lib/chat-thread-ref");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const messages = (await import("@/i18n/langs/en.json")).default;
const originalDrafts = useChatDraftStore.getState().draftsByThreadKey;
const queryClients: InstanceType<typeof QueryClient>[] = [];

afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const queryClient of queryClients) {
      queryClient.clear();
    }
    queryClients.length = 0;
  });
  useChatDraftStore.setState({ draftsByThreadKey: originalDrafts });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
  if (previousApiUrl === undefined) {
    delete process.env["VITE_API_URL"];
  } else {
    process.env["VITE_API_URL"] = previousApiUrl;
  }
});

const Composer = ({
  threadRef,
  controllerRef,
}: {
  threadRef: ChatThreadRef;
  controllerRef: Ref<ChatEditorController>;
}) => {
  const controller = useChatEditor({ threadRef });
  useImperativeHandle(controllerRef, () => controller, [controller]);
  return <EditorContent editor={controller.editor} />;
};

test("a rejected old-thread submit restores its stored draft without replacing the mounted new-thread editor", async () => {
  const previousRef = {
    scope: "global",
    threadId: toChatThreadId("submit-previous-thread"),
  } as const;
  const nextRef = {
    scope: "global",
    threadId: toChatThreadId("submit-next-thread"),
  } as const;
  const previousKey = getChatThreadKey(previousRef);
  const nextKey = getChatThreadKey(nextRef);
  const oldText = "Restore this unsent old-thread draft";
  const nextText = "Keep this newer thread draft";
  const oldDoc = createChatComposerDocument(composerText(oldText));
  useChatDraftStore
    .getState()
    .setDraft(
      previousKey,
      createChatDraftState({ attachments: [], doc: oldDoc }),
    );
  const queryClient = new QueryClient();
  queryClients.push(queryClient);
  const wrapper = ({ children }: PropsWithChildren) => (
    <ChatThreadTestRouter>
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatEditorProvider>{children}</ChatEditorProvider>
        </IntlProvider>
      </QueryClientProvider>
    </ChatThreadTestRouter>
  );
  const controllerRef = createRef<ChatEditorController>();
  const controller = () => {
    if (controllerRef.current === null) {
      panic("The composer did not expose its mounted editor controller");
    }
    return controllerRef.current;
  };
  const view = render(
    <Composer threadRef={previousRef} controllerRef={controllerRef} />,
    { wrapper },
  );
  await waitFor(() => expect(controller().editor?.getText()).toBe(oldText));
  const editor = controller().editor;
  if (editor === null) {
    panic("The composer did not create its editor");
  }
  const editorNode = editor.view.dom;
  expect(editorNode.isConnected).toBe(true);
  const pending = Promise.withResolvers<undefined>();
  const submissions: Promise<void>[] = [];
  act(() => {
    submissions.push(controller().submit(async () => await pending.promise));
  });
  const submission = submissions.at(0);
  if (submission === undefined) {
    panic("The composer did not start its submission");
  }
  const failure = new ChatSubmitPreservedError({
    message: "Synthetic submit refused",
  });
  const rejected = rejectionOf(submission);
  expect(useChatDraftStore.getState().getDraft(previousKey)).toBeNull();
  expect(editor.getText()).toBe("");

  view.rerender(<Composer threadRef={nextRef} controllerRef={controllerRef} />);
  await act(async () => {
    controller().setContent(composerText(nextText));
  });
  await waitFor(() => {
    expect(controller().editor?.getText()).toBe(nextText);
    expect(useChatDraftStore.getState().getDraft(nextKey)?.doc).toEqual(
      editor.getJSON(),
    );
  });
  const nextDoc = editor.getJSON();
  expect(controller().editor).toBe(editor);
  expect(editor.view.dom).toBe(editorNode);

  await act(async () => {
    pending.reject(failure);
    expect(await rejected).toBe(failure);
  });
  expect(controller().editor).toBe(editor);
  expect(editor.view.dom).toBe(editorNode);
  expect(editorNode.isConnected).toBe(true);
  expect(editor.getText()).toBe(nextText);
  expect(editor.getJSON()).toEqual(nextDoc);
  expect(useChatDraftStore.getState().getDraft(nextKey)?.doc).toEqual(nextDoc);
  expect(useChatDraftStore.getState().getDraft(previousKey)?.doc).toEqual(
    oldDoc,
  );
});
