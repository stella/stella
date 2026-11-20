import type { Ref } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { createRef, useImperativeHandle } = await import("react");
const { cleanup, createEvent, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { ChatEditorProvider, useChatEditor } =
  await import("@/components/chat-editor-provider");
const { installStrayFileDropGuard } =
  await import("@/components/stray-file-drop-guard");
const { useChatDraftStore } = await import("@/lib/chat-draft-store");
const { getChatThreadKey, toChatThreadId } =
  await import("@/lib/chat-thread-ref");
const { ChatThreadShell } = await import("./chat-thread.pending");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const threadRef = {
  scope: "global",
  threadId: toChatThreadId("thread-file-drop"),
} as const;

afterEach(() => {
  cleanup();
  useChatDraftStore.getState().clearDraft(getChatThreadKey(threadRef));
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

/** The thread page's wiring: the composer box keeps its own drop handlers,
 *  as `ChatInputSurface` does, and the shell widens them to the pane. */
const ThreadHarness = ({ ref }: { ref: Ref<ChatEditorController> }) => {
  const controller = useChatEditor({ threadRef });
  useImperativeHandle(ref, () => controller, [controller]);
  return (
    <ChatThreadShell
      composer={
        <div
          data-testid="composer"
          onDragOver={controller.handleDragOver}
          onDrop={controller.handleDrop}
        />
      }
      fileDrop={{
        onDragOver: controller.handleDragOver,
        onDrop: controller.handleDrop,
      }}
      headerActions={null}
      transcript={<div data-testid="transcript" />}
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
      <IntlProvider locale="en" messages={messages}>
        <ChatThreadTestRouter>
          <ChatEditorProvider>
            <ThreadHarness ref={ref} />
          </ChatEditorProvider>
        </ChatThreadTestRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(ref.current?.editor?.isInitialized).toBe(true));
  return {
    ui,
    attachments: () => ref.current?.attachments ?? [],
    unmount: () => {
      ui.unmount();
      client.clear();
    },
  };
};

const fileDataTransfer = (file: File) => ({
  dropEffect: "copy",
  files: [file],
  getData: () => "",
  types: ["Files"],
});

const docx = () =>
  new File(["docx bytes"], "contract.docx", { type: DOCX_MIME });

test("a docx let go over the transcript attaches and is not the browser's", async () => {
  const { ui, attachments, unmount } = await mount();
  const drop = createEvent.drop(ui.getByTestId("transcript"), {
    dataTransfer: fileDataTransfer(docx()),
  });
  fireEvent(ui.getByTestId("transcript"), drop);

  await waitFor(() => expect(attachments()).toHaveLength(1));
  expect(attachments().at(0)).toMatchObject({
    type: "file",
    filename: "contract.docx",
    mimeType: DOCX_MIME,
  });
  expect(drop.defaultPrevented).toBe(true);
  unmount();
});

test("a docx let go over the composer attaches once, not again in the pane", async () => {
  const { ui, attachments, unmount } = await mount();
  fireEvent.drop(ui.getByTestId("composer"), {
    dataTransfer: fileDataTransfer(docx()),
  });

  await waitFor(() => expect(attachments()).toHaveLength(1));
  unmount();
});

test("a file dropped where no drop zone claims it never reaches the browser", () => {
  const uninstall = installStrayFileDropGuard(window);
  const outside = document.createElement("div");
  document.body.append(outside);
  const dataTransfer = fileDataTransfer(docx());

  const dragOver = createEvent.dragOver(outside, { dataTransfer });
  fireEvent(outside, dragOver);
  expect(dragOver.defaultPrevented).toBe(true);
  expect(dragOver.dataTransfer?.dropEffect).toBe("none");

  const drop = createEvent.drop(outside, { dataTransfer });
  fireEvent(outside, drop);
  expect(drop.defaultPrevented).toBe(true);

  // A zone that took the drag keeps its own drop effect.
  const claim = (event: Event) => {
    event.preventDefault();
  };
  outside.addEventListener("dragover", claim);
  const claimed = createEvent.dragOver(outside, {
    dataTransfer: fileDataTransfer(docx()),
  });
  fireEvent(outside, claimed);
  expect(claimed.dataTransfer?.dropEffect).not.toBe("none");

  outside.removeEventListener("dragover", claim);
  outside.remove();
  uninstall();
});
