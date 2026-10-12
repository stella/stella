import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} = await import("@stll/ui/menu");
const { COMPOSER_LIST_VIEWPORT_CLASS_NAME } =
  await import("./composer-submenu-search");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

const OPEN = "Open";
const SKILLS = "Skills";
const ROWS = Array.from({ length: 30 }, (_, index) => `Row ${index}`);

const scrollingListOf = (row: HTMLElement) => {
  const list = row.closest(".overflow-y-auto");
  if (!(list instanceof HTMLElement)) {
    throw new Error("Expected the row inside the menu's scrolling list");
  }
  return list;
};

const expectCapped = (list: HTMLElement) => {
  for (const className of COMPOSER_LIST_VIEWPORT_CLASS_NAME.split(" ")) {
    expect(list.classList.contains(className)).toBe(true);
  }
};

test("a plain menu keeps one scrolling list inside a popup capped to the available height", async () => {
  render(
    <Menu>
      <MenuTrigger>{OPEN}</MenuTrigger>
      <MenuPopup>
        {ROWS.map((row) => (
          <MenuItem key={row}>{row}</MenuItem>
        ))}
      </MenuPopup>
    </Menu>,
  );
  fireEvent.click(screen.getByText(OPEN));
  const lastRow = await waitFor(() => screen.getByText("Row 29"));

  const list = scrollingListOf(lastRow);
  const popup = list.parentElement;
  if (!popup) {
    throw new Error("Expected the menu popup");
  }
  // Without a header the list is the popup's only child, as before.
  expect(popup.children.length).toBe(1);
  expect(popup.classList.contains("max-h-(--available-height)")).toBe(true);
  expect(list.contains(screen.getByText("Row 0"))).toBe(true);
});

test("a menu header sits before the scrolling list, outside it", async () => {
  render(
    <Menu>
      <MenuTrigger>{OPEN}</MenuTrigger>
      <MenuPopup
        header={<input aria-label="Search rows" dir="ltr" />}
        viewportClassName={COMPOSER_LIST_VIEWPORT_CLASS_NAME}
      >
        {ROWS.map((row) => (
          <MenuItem key={row}>{row}</MenuItem>
        ))}
      </MenuPopup>
    </Menu>,
  );
  fireEvent.click(screen.getByText(OPEN));
  const lastRow = await waitFor(() => screen.getByText("Row 29"));

  const list = scrollingListOf(lastRow);
  const search = screen.getByLabelText("Search rows");
  // Outside the list, a row scrolled into view while moving up with the
  // keyboard can never end up hidden under the search field.
  expect(list.contains(search)).toBe(false);
  expect(search.nextElementSibling).toBe(list);
  expectCapped(list);
});

test("a submenu header sits before its capped scrolling list, outside it", async () => {
  render(
    <Menu>
      <MenuTrigger>{OPEN}</MenuTrigger>
      <MenuPopup>
        <MenuSub>
          <MenuSubTrigger>{SKILLS}</MenuSubTrigger>
          <MenuSubPopup
            header={<input aria-label="Search skills" dir="ltr" />}
            viewportClassName={COMPOSER_LIST_VIEWPORT_CLASS_NAME}
          >
            {ROWS.map((row) => (
              <MenuItem key={row}>{row}</MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      </MenuPopup>
    </Menu>,
  );
  fireEvent.click(screen.getByText(OPEN));
  const subTrigger = await waitFor(() => screen.getByText(SKILLS));
  fireEvent.click(subTrigger);
  const lastRow = await waitFor(() => screen.getByText("Row 29"));

  const list = scrollingListOf(lastRow);
  const search = screen.getByLabelText("Search skills");
  expect(list.contains(search)).toBe(false);
  expect(search.nextElementSibling).toBe(list);
  expectCapped(list);
});
