import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { emit } = await import("@tauri-apps/api/event");
const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const { default: ClipboardEditorWindow } =
  await import("../src/clipboard/ClipboardEditor");
const { CLIPBOARD_HISTORY_CHANGED_EVENT } =
  await import("../src/clipboard/clipboard-types");
const { DesktopIntlProvider, defaultMessages } = await import("../src/i18n");

afterEach(() => {
  cleanup();
  clearMocks();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const CLIP_GONE = "clipboard item no longer exists";

const CONTEXT = {
  groupLimit: 24,
  groups: [],
  item: {
    copiedAt: "2026-09-04T07:00:00.000Z",
    groupId: null,
    groupedAt: null,
    id: "clip-1",
    name: "Lease clause",
    plainText: "The tenant shall keep the premises in good repair.",
    sourceApp: null,
    type: "text",
  },
  sourceAppVisual: null,
};

type NativeRead = { type: "open" } | { message: string; type: "failed" };

/** Renders the editor over a native side whose reads follow `native.read`. */
const renderEditor = async (native: { read: NativeRead }) => {
  const reports: unknown[] = [];
  mockIPC(
    (command, payload) => {
      if (command === "clipboard_get_editor_context") {
        if (native.read.type === "failed") {
          // A native command rejects with its bare message.
          return Promise.reject<never>(native.read.message);
        }
        return CONTEXT;
      }
      if (command === "desktop_report_error") {
        reports.push(payload);
      }
      return null;
    },
    { shouldMockEvents: true },
  );
  const view = render(
    <DesktopIntlProvider language="en" messages={defaultMessages}>
      <ClipboardEditorWindow />
    </DesktopIntlProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, reports };
};

const loadError = defaultMessages.clipboard.errorReadHistory;

test.each([
  { message: CLIP_GONE, reported: 0 },
  { message: "clipboard state lock is poisoned", reported: 1 },
])(
  "a reload that fails with $message keeps the open draft",
  async ({ message, reported }) => {
    const native: { read: NativeRead } = { read: { type: "open" } };
    const { findByDisplayValue, queryByText, reports } =
      await renderEditor(native);
    fireEvent.change(await findByDisplayValue(CONTEXT.item.name), {
      target: { value: "Draft name" },
    });

    native.read = { message, type: "failed" };
    await act(async () => {
      await emit(CLIPBOARD_HISTORY_CHANGED_EVENT);
    });

    await findByDisplayValue("Draft name");
    expect(queryByText(loadError)).toBeNull();
    expect(reports).toHaveLength(reported);
  },
);

test("the error screen still answers a clip that cannot be read when it opens", async () => {
  const { findByText } = await renderEditor({
    read: { message: "clipboard read failed", type: "failed" },
  });

  await findByText(loadError);
});
