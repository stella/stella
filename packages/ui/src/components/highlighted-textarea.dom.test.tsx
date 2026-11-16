import { createRef, useState } from "react";
import type * as React from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { HighlightedTextarea } = await import("./highlighted-textarea");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const Editor = ({
  onKeyDown,
}: Pick<React.ComponentProps<typeof HighlightedTextarea>, "onKeyDown">) => {
  const [value, setValue] = useState("Initial");
  return (
    <HighlightedTextarea
      aria-label="Draft"
      highlightedContent={value}
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      value={value}
    />
  );
};

test("keeps controlled editing and forwards native Enter and composition events", () => {
  const keys: {
    key: string;
    composing: boolean;
    shifted: boolean;
    prevented: boolean;
  }[] = [];
  const view = render(
    <Editor
      onKeyDown={(event) =>
        keys.push({
          key: event.key,
          composing: event.nativeEvent.isComposing,
          shifted: event.shiftKey,
          prevented: event.defaultPrevented,
        })
      }
    />,
  );
  const editor = view.getByRole("textbox", {
    name: "Draft",
  });
  fireEvent.change(editor, { target: { value: "قانون\nExample" } });
  expect(editor).toHaveProperty("value", "قانون\nExample");
  expect(
    view.container.querySelector('[data-slot="highlighted-textarea-backdrop"]')
      ?.textContent,
  ).toBe("قانون\nExample");
  fireEvent.keyDown(editor, { key: "Enter" });
  fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
  expect(keys).toEqual([
    { key: "Enter", composing: false, shifted: false, prevented: false },
    { key: "Enter", composing: false, shifted: true, prevented: false },
    { key: "Enter", composing: true, shifted: false, prevented: false },
  ]);
});

test("keeps the native editor ref, selection and both-axis scroll before forwarding the event", () => {
  const ref = createRef<HTMLTextAreaElement>();
  const observed: { top: number; left: number }[] = [];
  const view = render(
    <HighlightedTextarea
      aria-label="Draft"
      highlightedContent="Example"
      onChange={() => undefined}
      onScroll={() => {
        const backdrop = view.container.querySelector(
          '[data-slot="highlighted-textarea-backdrop"]',
        );
        if (backdrop) {
          observed.push({ top: backdrop.scrollTop, left: backdrop.scrollLeft });
        }
      }}
      ref={ref}
      value="Example"
    />,
  );
  const editor = view.getByRole("textbox", {
    name: "Draft",
  });
  expect(ref.current === editor).toBe(true);
  ref.current?.setSelectionRange(1, 4);
  expect(ref.current?.selectionStart).toBe(1);
  expect(ref.current?.selectionEnd).toBe(4);
  fireEvent.scroll(editor, { target: { scrollTop: 72, scrollLeft: -18 } });
  expect(observed).toEqual([{ top: 72, left: -18 }]);
});

test("inherits surrounding direction without assigning content-dependent direction to either layer", () => {
  const view = render(
    <section dir="rtl">
      <HighlightedTextarea
        aria-label="Draft"
        highlightedContent="Example قانون"
        onChange={() => undefined}
        value="Example قانون"
      />
    </section>,
  );
  const editor = view.getByRole("textbox", {
    name: "Draft",
  });
  const owner = editor.closest('[data-slot="highlighted-textarea"]');
  expect(owner?.getAttribute("dir")).toBeNull();
  expect(editor.getAttribute("dir")).toBeNull();
  expect(owner?.parentElement?.getAttribute("dir")).toBe("rtl");
});

test("only the hidden backdrop completes a trailing blank line", () => {
  const view = render(
    <HighlightedTextarea
      aria-label="Draft"
      highlightedContent={"Line\n"}
      onChange={() => undefined}
      value={"Line\n"}
    />,
  );
  const backdrop = () =>
    view.container.querySelector('[data-slot="highlighted-textarea-backdrop"]')
      ?.textContent;
  expect(backdrop()).toBe("Line\n\u200b");
  expect(view.getByRole("textbox", { name: "Draft" })).toHaveProperty(
    "value",
    "Line\n",
  );
  view.rerender(
    <HighlightedTextarea
      aria-label="Draft"
      highlightedContent="Line"
      onChange={() => undefined}
      value="Line"
    />,
  );
  expect(backdrop()).toBe("Line");
  expect(view.getByRole("textbox", { name: "Draft" })).toHaveProperty(
    "value",
    "Line",
  );
});

test("wider native props cannot replace the owned layers", () => {
  const wider = {
    children: "Other",
    defaultValue: "Other",
    style: { padding: 99 },
    wrap: "off" as const,
  };
  const view = render(
    <HighlightedTextarea
      {...wider}
      aria-label="Draft"
      highlightedContent="Current"
      onChange={() => undefined}
      value="Current"
    />,
  );
  const editor = view.getByRole("textbox", { name: "Draft" });
  expect(editor).toHaveProperty("value", "Current");
  expect(editor.textContent).toBe("Current");
  expect(editor.getAttribute("style")).toBeNull();
  expect(editor.getAttribute("wrap")).toBeNull();
  expect(
    view.container.querySelector('[data-slot="highlighted-textarea-backdrop"]')
      ?.textContent,
  ).toBe("Current");
});
