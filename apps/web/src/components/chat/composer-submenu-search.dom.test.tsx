import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { createRef } = await import("react");
const { act } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { ComposerSubmenuSearch } = await import("./composer-submenu-search");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

type RenderPickerOptions = {
  value: string;
  withTrigger: boolean;
};

// The picker's shape: a menu popup holding the search field and a row, plus
// a nested submenu, which Base UI portals into a separate node.
const renderPicker = ({ value, withTrigger }: RenderPickerOptions) => {
  const searchRef = createRef<HTMLInputElement>();
  const erased: string[] = [];
  const view = render(
    <>
      <div role="menu">
        <ComposerSubmenuSearch
          onChange={() => {}}
          placeholder="Search"
          ref={searchRef}
          trigger={
            withTrigger
              ? {
                  char: "@",
                  onErase: () => {
                    erased.push("erased");
                  },
                }
              : undefined
          }
          value={value}
        />
        <div role="menuitem" tabIndex={-1} />
      </div>
      <div role="menu">
        <div role="menuitem" tabIndex={-1} />
      </div>
    </>,
  );
  const [row, nestedRow] = view.getAllByRole("menuitem");
  if (!row || !nestedRow || !searchRef.current) {
    throw new Error("Expected the picker to render its field and rows");
  }
  return { erased, nestedRow, row, search: searchRef.current };
};

const focus = (element: HTMLElement) => {
  act(() => {
    element.focus();
  });
};

test("a letter typed while a hovered row holds focus goes to the search field", () => {
  const { row, search } = renderPicker({ value: "ex", withTrigger: true });
  focus(row);

  // `fireEvent` returns false when the default action was prevented; the
  // field must receive the key's default (the character or the deletion).
  expect(fireEvent.keyDown(row, { key: "e" })).toBe(true);
  expect(document.activeElement).toBe(search);

  focus(row);
  expect(fireEvent.keyDown(row, { key: "Backspace" })).toBe(true);
  expect(document.activeElement).toBe(search);
});

test("Backspace past an empty query erases the trigger from a row or the field", () => {
  const { erased, row, search } = renderPicker({
    value: "",
    withTrigger: true,
  });
  focus(row);
  expect(fireEvent.keyDown(row, { key: "Backspace" })).toBe(false);
  expect(erased).toEqual(["erased"]);

  focus(search);
  expect(fireEvent.keyDown(search, { key: "Backspace" })).toBe(false);
  expect(erased).toEqual(["erased", "erased"]);
});

test("navigation and Space stay with the highlighted row", () => {
  const { row } = renderPicker({ value: "ex", withTrigger: true });
  for (const key of ["ArrowDown", "Enter", "Escape", " "]) {
    focus(row);
    fireEvent.keyDown(row, { key });
    expect(document.activeElement).toBe(row);
  }
});

test("keys in a nested submenu stay in that submenu", () => {
  const { erased, nestedRow } = renderPicker({ value: "", withTrigger: true });
  focus(nestedRow);
  fireEvent.keyDown(nestedRow, { key: "e" });
  fireEvent.keyDown(nestedRow, { key: "Backspace" });
  expect(document.activeElement).toBe(nestedRow);
  expect(erased).toEqual([]);
});

test("a (+) submenu search without a trigger only takes the key back", () => {
  const { erased, row, search } = renderPicker({
    value: "",
    withTrigger: false,
  });
  focus(row);
  expect(fireEvent.keyDown(row, { key: "Backspace" })).toBe(true);
  expect(document.activeElement).toBe(search);
  expect(erased).toEqual([]);
});
