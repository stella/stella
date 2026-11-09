import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const { act, cleanup, render } = await import("@testing-library/react");
const { detectPlatform, useHotkey } = await import("@tanstack/react-hotkeys");
const { HOTKEYS, keepKeyPressLocal } = await import("@/lib/hotkeys");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

type Counts = { search: number; ancestor: number };

const Surface = ({
  onSearch,
  onAncestorKey,
  onKeyDown,
}: {
  onSearch: () => void;
  onAncestorKey: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) => {
  useHotkey(HOTKEYS.SEARCH, onSearch);
  return (
    <div onKeyDown={onAncestorKey} role="presentation">
      <div onKeyDown={onKeyDown} role="presentation">
        <input aria-label="text" dir="ltr" />
      </div>
    </div>
  );
};

const counter = () => {
  const counts: Counts = { search: 0, ancestor: 0 };
  return {
    counts,
    onSearch: () => {
      counts.search += 1;
    },
    onAncestorKey: () => {
      counts.ancestor += 1;
    },
  };
};

const press = (
  target: Element,
  key: string,
  withMod: boolean,
  code = `Key${key.toUpperCase()}`,
) => {
  const mac = detectPlatform() === "mac";
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code,
        ctrlKey: withMod && !mac,
        metaKey: withMod && mac,
        bubbles: true,
      }),
    );
  });
};

describe("a text surface that keeps key presses local", () => {
  test("still lets an active app hotkey through and keeps typing from its ancestors", () => {
    const { counts, ...handlers } = counter();
    const view = render(
      <Surface {...handlers} onKeyDown={keepKeyPressLocal} />,
    );
    const input = view.getByLabelText("text");

    // The hotkey's press propagates, so the ancestor sees it too.
    press(input, "k", true);
    expect(counts).toEqual({ search: 1, ancestor: 1 });

    // Plain typing stays inside the surface.
    press(input, "a", false);
    expect(counts).toEqual({ search: 1, ancestor: 1 });
  });

  test("lets the hotkey through from a non-Latin layout, as its dispatch does", () => {
    const { counts, ...handlers } = counter();
    const view = render(
      <Surface {...handlers} onKeyDown={keepKeyPressLocal} />,
    );

    // A Russian layout reports Ctrl+K as Ctrl+л on the K key.
    press(view.getByLabelText("text"), "л", true, "KeyK");
    expect(counts).toEqual({ search: 1, ancestor: 1 });
  });

  test("a surface that stops every press silences the hotkey", () => {
    const { counts, ...handlers } = counter();
    const view = render(
      <Surface
        {...handlers}
        onKeyDown={(event) => {
          event.stopPropagation();
        }}
      />,
    );

    press(view.getByLabelText("text"), "k", true);
    expect(counts).toEqual({ search: 0, ancestor: 0 });
  });
});
