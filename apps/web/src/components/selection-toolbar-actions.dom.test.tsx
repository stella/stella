import { useRef } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import { createWebTestEnvironment } from "../../tests/environment.test-fixtures";

GlobalRegistrator.register({ url: "https://app.example.test/law" });
const testEnvironment = createWebTestEnvironment({ file: import.meta.path });
testEnvironment.setEnvIfAbsent("VITE_API_URL", "https://api.example.test");
const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { SelectionCopyButton, useSelectionCopy } =
  await import("./selection-toolbar-actions");

const OWNED_TEXT = "The seller shall deliver the goods.";
const OTHER_TEXT = "Matter notes";

afterEach(async () => {
  document.getSelection()?.removeAllRanges();
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

/**
 * A bar whose Copy stays on screen whatever is selected, so the owner's
 * confirmation is observable for a selection the bar does not own.
 */
const Bar = () => {
  const rootRef = useRef<HTMLElement | null>(null);
  const copy = useSelectionCopy({
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
      <SelectionCopyButton content={{ plain: OWNED_TEXT }} copy={copy} />
    </>
  );
};

const mountBar = () =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <Bar />
    </IntlProvider>,
  );

const selectText = (view: ReturnType<typeof mountBar>, text: string) => {
  const node = view.getByText(text).firstChild;
  if (node === null) {
    throw new TypeError(`Missing text fixture: ${text}`);
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
};

const nativeCopy = async () => {
  await act(async () => {
    document.dispatchEvent(new Event("copy", { bubbles: true }));
  });
};

const copyButton = (view: ReturnType<typeof mountBar>) =>
  view.getByRole("button", {
    name: new RegExp(
      `^(${messages.common.copy}|${messages.common.copied})$`,
      "u",
    ),
  });

test("a native copy of the owned selection confirms Copy", async () => {
  const view = mountBar();
  selectText(view, OWNED_TEXT);

  await nativeCopy();

  expect(copyButton(view).getAttribute("aria-label")).toBe(
    messages.common.copied,
  );
});

test("a native copy of another selection leaves Copy unconfirmed", async () => {
  const view = mountBar();
  selectText(view, OTHER_TEXT);

  await nativeCopy();

  expect(copyButton(view).getAttribute("aria-label")).toBe(
    messages.common.copy,
  );
});

test("a collapsed selection confirms nothing", async () => {
  const view = mountBar();
  selectText(view, OWNED_TEXT);
  document.getSelection()?.collapseToStart();

  await nativeCopy();

  expect(copyButton(view).getAttribute("aria-label")).toBe(
    messages.common.copy,
  );
});

test("a selection change ends a native copy's confirmation", async () => {
  const view = mountBar();
  selectText(view, OWNED_TEXT);
  await nativeCopy();
  expect(copyButton(view).getAttribute("aria-label")).toBe(
    messages.common.copied,
  );

  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
  });

  expect(copyButton(view).getAttribute("aria-label")).toBe(
    messages.common.copy,
  );
});
