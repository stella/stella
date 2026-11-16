import { useRef } from "react";
import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { createWebTestEnvironment } from "../../tests/environment.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test/law" });
const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { stellaToast } = await import("@stll/ui/toast");
const { detached } = await import("@/lib/detached");
const {
  CopyControl,
  CopyControlButton,
  useCopyControl,
  useSelectionCopyControl,
} = await import("./copy-control");

const REFERENCE = "2026/014-A";
const OWNED_TEXT = "The seller shall deliver the goods.";
const OTHER_TEXT = "Matter notes";

let clipboardWrites: string[] = [];
beforeEach(() => {
  clipboardWrites = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboardWrites.push(text);
      },
    },
  });
});
afterEach(async () => {
  document.getSelection()?.removeAllRanges();
  await act(async () => cleanup());
  mock.restore();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const withIntl = (children: ReactNode) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </IntlProvider>,
  );

const COPY_NAME = new RegExp(
  `^(${messages.common.copy}|${messages.common.copied})$`,
  "u",
);
const copyState = (view: ReturnType<typeof withIntl>) =>
  view.getByRole("button", { name: COPY_NAME }).getAttribute("aria-label");

const selectText = (node: Node) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
};

const selectTextOf = (view: ReturnType<typeof withIntl>, text: string) => {
  const node = view.getByText(text).firstChild;
  if (node === null) {
    throw new TypeError(`Missing text fixture: ${text}`);
  }
  selectText(node);
};

const nativeCopy = async (
  event: Event = new Event("copy", { bubbles: true }),
) => {
  await act(async () => {
    document.dispatchEvent(event);
  });
};

// --- A value ----------------------------------------------------------------

/** A value shown on screen beside its Copy, as setup rows show theirs. */
const ValueRow = ({ shown, value }: { shown: string; value: string }) => (
  <p>
    <code>{shown}</code>
    <CopyControl text={value} />
  </p>
);

test("pressing Copy writes the value and confirms in place", async () => {
  const view = withIntl(<ValueRow shown={REFERENCE} value={REFERENCE} />);

  fireEvent.click(view.getByRole("button", { name: messages.common.copy }));

  await waitFor(() => expect(copyState(view)).toBe(messages.common.copied));
  expect(clipboardWrites).toEqual([REFERENCE]);
});

test("a failed write reports the error and does not confirm", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => await Promise.reject(new Error("denied")) },
  });
  const toast = spyOn(stellaToast, "add").mockReturnValue("error-toast");
  const view = withIntl(<ValueRow shown={REFERENCE} value={REFERENCE} />);

  fireEvent.click(view.getByRole("button", { name: messages.common.copy }));

  await waitFor(() => expect(toast).toHaveBeenCalled());
  expect(copyState(view)).toBe(messages.common.copy);
  toast.mockRestore();
});

test("the reader's own copy of exactly the value confirms its Copy", async () => {
  const view = withIntl(<ValueRow shown={REFERENCE} value={REFERENCE} />);
  selectTextOf(view, REFERENCE);

  await nativeCopy();

  expect(copyState(view)).toBe(messages.common.copied);
});

test("whitespace and line endings do not tell a copy apart", async () => {
  const view = withIntl(
    <ValueRow shown={"Line one\r\n  line two "} value={"Line one\nline two"} />,
  );
  const shown = view.container.querySelector("code")?.firstChild;
  if (shown === null || shown === undefined) {
    throw new TypeError("Missing value fixture");
  }
  selectText(shown);

  await nativeCopy();

  expect(copyState(view)).toBe(messages.common.copied);
});

test("almost the same text does not confirm", async () => {
  // Part of the value, the value with a character more, and other words.
  for (const shown of ["2026/014", `${REFERENCE}.`, OTHER_TEXT]) {
    const view = withIntl(<ValueRow shown={shown} value={REFERENCE} />);
    selectTextOf(view, shown);

    await nativeCopy();

    expect(copyState(view)).toBe(messages.common.copy);
    await act(async () => cleanup());
  }
});

test("a collapsed selection confirms nothing", async () => {
  const view = withIntl(<ValueRow shown={REFERENCE} value={REFERENCE} />);
  selectTextOf(view, REFERENCE);
  document.getSelection()?.collapseToStart();

  await nativeCopy();

  expect(copyState(view)).toBe(messages.common.copy);
});

test("a surface that rewrites the copied text is compared by what it wrote", async () => {
  const view = withIntl(<ValueRow shown={OTHER_TEXT} value={REFERENCE} />);
  selectTextOf(view, OTHER_TEXT);
  // A surface's own handler replaces the selection with its payload.
  const rewrite = (event: Event) => {
    if (event instanceof ClipboardEvent) {
      event.clipboardData?.setData("text/plain", REFERENCE);
    }
    event.preventDefault();
  };
  document.addEventListener("copy", rewrite);

  await nativeCopy(
    new ClipboardEvent("copy", {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    }),
  );

  document.removeEventListener("copy", rewrite);
  expect(copyState(view)).toBe(messages.common.copied);
});

// --- A selection bar ----------------------------------------------------------

/** A bar whose Copy stays on screen whatever is selected. */
const SelectionBar = () => {
  const rootRef = useRef<HTMLElement | null>(null);
  const control = useSelectionCopyControl({
    ownsSelection: (selection, root) =>
      root.contains(selection.anchorNode) && root.contains(selection.focusNode),
    rootRef,
  });
  return (
    <>
      <article ref={rootRef}>
        <p>{OWNED_TEXT}</p>
      </article>
      <p>{OTHER_TEXT}</p>
      <CopyControlButton content={OWNED_TEXT} control={control} />
    </>
  );
};

test("a selection bar confirms the reader's own copy of the words it owns", async () => {
  const view = withIntl(<SelectionBar />);
  selectTextOf(view, OWNED_TEXT);

  await nativeCopy();

  expect(copyState(view)).toBe(messages.common.copied);
});

test("a selection bar ignores a copy of words it does not own", async () => {
  const view = withIntl(<SelectionBar />);
  selectTextOf(view, OTHER_TEXT);

  await nativeCopy();

  expect(copyState(view)).toBe(messages.common.copy);
});

test("a selection change ends a selection bar's confirmation", async () => {
  const view = withIntl(<SelectionBar />);
  selectTextOf(view, OWNED_TEXT);
  await nativeCopy();
  expect(copyState(view)).toBe(messages.common.copied);

  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
  });

  expect(copyState(view)).toBe(messages.common.copy);
});

test("a press that settles after the selection changed does not confirm", async () => {
  const pending = Promise.withResolvers<undefined>();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => await pending.promise },
  });
  const view = withIntl(<SelectionBar />);

  fireEvent.click(view.getByRole("button", { name: messages.common.copy }));
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  await act(async () => {
    pending.resolve(undefined);
    await pending.promise;
  });

  expect(copyState(view)).toBe(messages.common.copy);
});

// --- A menu item --------------------------------------------------------------

const MenuItemCopy = () => {
  const control = useCopyControl({ confirmation: "toast" });
  return (
    <button
      onClick={() => {
        detached(
          control.copy("https://app.example.test/workspaces/1"),
          "copy-control.menu-item",
        );
      }}
      type="button"
    >
      {messages.common.copyLink}
    </button>
  );
};

test("a menu item's Copy confirms by toast", async () => {
  const toast = spyOn(stellaToast, "add").mockReturnValue("copied-toast");
  const view = withIntl(<MenuItemCopy />);

  fireEvent.click(view.getByRole("button", { name: messages.common.copyLink }));

  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith({
      title: messages.common.copied,
      type: "success",
    }),
  );
  expect(clipboardWrites).toEqual(["https://app.example.test/workspaces/1"]);
  toast.mockRestore();
});
