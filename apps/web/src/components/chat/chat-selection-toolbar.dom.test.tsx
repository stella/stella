import { createRef } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { createTestState } from "../../../../api/src/tests/helpers/test-state";

GlobalRegistrator.register({ url: "https://app.example.test/chat/thread" });
const testState = createTestState({ file: import.meta.path, config: {} });
testState.setEnv(
  "VITE_API_URL",
  process.env["VITE_API_URL"] ?? "https://api.example.test",
);
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { ChatEditorProvider } =
  await import("@/components/chat-editor-provider");
const { ChatSelectionToolbar } = await import("./chat-selection-toolbar");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { createAppQueryClient } = await import("@/lib/react-query");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");

const SELECTED_TEXT = "old text";

const originalRects = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);
Object.defineProperty(Range.prototype, "getClientRects", {
  configurable: true,
  value: () => {
    const rect = new DOMRect(20, 40, 80, 20);
    return {
      0: rect,
      length: 1,
      item: () => rect,
      [Symbol.iterator]: () => [rect][Symbol.iterator](),
    };
  },
});

afterEach(async () => {
  document.getSelection()?.removeAllRanges();
  await act(async () => cleanup());
});
afterAll(async () => {
  if (originalRects) {
    Object.defineProperty(Range.prototype, "getClientRects", originalRects);
  }
  await GlobalRegistrator.unregister();
});

const mountSelection = async ({
  ai = true,
  isGenerating = false,
  answerRewriteAvailability = "available",
}: {
  ai?: boolean;
  isGenerating?: boolean;
  answerRewriteAvailability?: "available" | "anonymized";
} = {}) => {
  document.documentElement.style.overflow = "visible";
  document.body.style.overflow = "visible";
  const rootRef = createRef<HTMLDivElement>();
  const capabilities = resolveActionCapabilities({
    role: "member",
    ai,
    deepl: false,
    ocr: false,
    desktop: "none",
    settings: undefined,
  });
  const view = render(
    <QueryClientProvider client={createAppQueryClient()}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ActionCapabilitiesProvider value={capabilities}>
          <ChatEditorProvider>
            <div ref={rootRef} style={{ overflow: "visible" }}>
              <div data-chat-message-id="message-1">
                <div data-text-part-index="0">
                  <span
                    data-src-start="0"
                    data-src-end="8"
                    data-src-offsets="0,1,2,3,4,5,6,7,8"
                  >
                    {SELECTED_TEXT}
                  </span>
                </div>
              </div>
            </div>
            <ChatSelectionToolbar
              rootRef={rootRef}
              source={{
                threadRef: {
                  scope: "global",
                  threadId: toChatThreadId(
                    "00000000-0000-4000-8000-000000000001",
                  ),
                },
                contextMatterIds: [],
              }}
              messages={[
                {
                  id: "message-1",
                  role: "assistant",
                  revision: 2,
                  parts: [{ type: "text", content: SELECTED_TEXT }],
                },
              ]}
              isGenerating={isGenerating}
              answerRewriteAvailability={answerRewriteAvailability}
              onAnswerEdited={async () => undefined}
            />
          </ChatEditorProvider>
        </ActionCapabilitiesProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  view.container.style.overflow = "visible";
  const root = rootRef.current;
  const leaf = view.getByText("old text");
  const text = leaf.firstChild;
  if (root === null || text === null) {
    throw new TypeError("Selection fixture is missing");
  }
  root.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 8);
  document.getSelection()?.addRange(range);
  await act(async () =>
    fireEvent.pointerUp(leaf, { clientX: 60, clientY: 50 }),
  );
  return view;
};

test("a mapped answer selection opens anchored instructions and Escape closes them", async () => {
  const view = await mountSelection();
  fireEvent.click(view.getByRole("button", { name: "Request edits" }));
  expect(view.getByRole("textbox").getAttribute("aria-invalid")).toBe("false");
  fireEvent.keyDown(view.getByRole("textbox"), { key: "Escape" });
  expect(view.queryByRole("textbox")).toBeNull();
});

test("a member without AI receives no AI selection actions", async () => {
  const view = await mountSelection({ ai: false });
  expect(view.queryByRole("button", { name: "Request edits" })).toBeNull();
  expect(view.getByRole("button", { name: "Copy" })).toBeTruthy();
});

test("streaming prevents opening an edit from the selection toolbar", async () => {
  const view = await mountSelection({ isGenerating: true });
  const action = view.getByRole("button", { name: "Request edits" });
  expect(action.hasAttribute("disabled")).toBe(true);
  fireEvent.click(action);
  expect(view.queryByRole("textbox")).toBeNull();
});

test("an anonymized conversation exposes no answer rewrite", async () => {
  const view = await mountSelection({
    answerRewriteAvailability: "anonymized",
  });
  expect(view.queryByRole("button", { name: "Request edits" })).toBeNull();
  expect(view.getByRole("button", { name: "Copy" })).toBeTruthy();
});
