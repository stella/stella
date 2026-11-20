import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import english from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { Streamdown } = await import("streamdown");
const { messageComponents } =
  await import("@/components/ai-elements/message-response-components");
const { answerTableText } =
  await import("@/components/ai-elements/answer-table.logic");
const { ANSWER_TABLE_TEXT_MODE_STORAGE_KEY, useAnswerTableTextModeStore } =
  await import("@/components/ai-elements/answer-table-text-mode-store");
const { userStorageKey } = await import("@/lib/account/user-scoped-storage");
const { browserStateStorage } = await import("@/lib/account/browser-storage");

// Read on each call: a test may swap the page's storage out.
const storage = () => browserStateStorage("local");

const storageKey = userStorageKey(ANSWER_TABLE_TEXT_MODE_STORAGE_KEY);

/** Puts back the page's own storage after a test replaced it. */
const restoreLocalStorage = (original: PropertyDescriptor | undefined) => {
  if (original === undefined) {
    // The storage was inherited (a getter on the prototype): drop the shadow.
    Reflect.deleteProperty(window, "localStorage");
    return;
  }
  Object.defineProperty(window, "localStorage", original);
};

const restoreStore = async () => {
  await act(async () => {
    await useAnswerTableTextModeStore.persist.rehydrate();
  });
};

beforeEach(() => {
  useAnswerTableTextModeStore.setState({ mode: "wrap" });
  storage().removeItem(storageKey);
});
afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const provisions =
  "| Provision | What it requires |\n| --- | --- |\n| Limitation of liability | Caps liability at twelve months of fees |\n| Termination | 30 days' notice, \"no reason\" |\n| Governing law | Supplier's seat; its courts |\n| Price | CPI, plus two points |";

const mount = (markdown = provisions, isAnimating = false) =>
  render(
    <IntlProvider locale="en" messages={english} timeZone="UTC">
      <Streamdown
        components={messageComponents}
        isAnimating={isAnimating}
        mode={isAnimating ? "streaming" : "static"}
      >
        {markdown}
      </Streamdown>
    </IntlProvider>,
  );

const shell = (container: HTMLElement) => {
  const element = container.querySelector('[data-slot="answer-table"]');
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("No answer table rendered");
  }
  return element;
};

test("the header strip names the table's body rows and columns", () => {
  const view = mount();
  const header = view.container.querySelector(
    '[data-slot="answer-table-header"]',
  );
  expect(header?.textContent).toContain("4 rows · 2 columns");
  cleanup();
  const single = mount("| Court |\n| --- |\n| Supreme Court |");
  expect(single.container.textContent).toContain("1 row · 1 column");
});

test("a streaming table counts only what has arrived and holds its actions", () => {
  const view = mount(
    "| Month | Hours |\n| --- | --- |\n| June | 12 |\n| July | 8 |\n| Aug",
    true,
  );
  // The header row fixes the width; the row still arriving already counts.
  expect(view.container.textContent).toContain("3 rows · 2 columns");
  for (const name of ["Copy table", "Download table", "Open full screen"]) {
    const control = view.getByRole("button", { name });
    // Disabled controls with a tooltip stay focusable, so they say so in ARIA.
    expect(
      control.hasAttribute("disabled") ||
        control.getAttribute("aria-disabled") === "true",
    ).toBe(true);
  }
  // The same table once settled offers its actions.
  cleanup();
  const settled = mount("| Month | Hours |\n| --- | --- |\n| June | 12 |");
  const copy = settled.getByRole("button", { name: "Copy table" });
  expect(copy.hasAttribute("disabled")).toBe(false);
  expect(copy.getAttribute("aria-disabled")).toBeNull();
});

test("single line mode applies to the table and is remembered", async () => {
  const view = mount();
  expect(shell(view.container).dataset["textMode"]).toBe("wrap");
  expect(view.getByRole("table").dataset["cellText"]).toBe("wrap");
  fireEvent.click(view.getByRole("button", { name: "Single line" }));
  expect(shell(view.container).dataset["textMode"]).toBe("single-line");
  // The table primitive keeps its cells on one line in this mode.
  expect(view.getByRole("table").dataset["cellText"]).toBe("single-line");
  expect(
    view
      .getByRole("button", { name: "Single line" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await waitFor(() =>
    expect(storage().getItem(storageKey)).toContain("single-line"),
  );
  fireEvent.click(view.getByRole("button", { name: "Wrap text" }));
  expect(shell(view.container).dataset["textMode"]).toBe("wrap");
  await waitFor(() =>
    expect(storage().getItem(storageKey)).not.toContain("single-line"),
  );
});

test("a remembered single line choice is restored on the next mount", async () => {
  storage().setItem(
    storageKey,
    JSON.stringify({ state: { mode: "single-line" }, version: 1 }),
  );
  await restoreStore();
  const view = mount();
  expect(shell(view.container).dataset["textMode"]).toBe("single-line");
});

test("an unreadable stored choice falls back to wrapping", async () => {
  storage().setItem(storageKey, "{not json");
  await restoreStore();
  const view = mount();
  expect(shell(view.container).dataset["textMode"]).toBe("wrap");
});

test("blocked storage neither breaks the table nor the mode switch", async () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  const calls: string[] = [];
  const refuse = (method: string) => () => {
    calls.push(method);
    throw new DOMException("Blocked", "SecurityError");
  };
  // Storage that is there but refuses every read and write (full, or site
  // data blocked after the page loaded).
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      length: 0,
      clear: refuse("clear"),
      getItem: refuse("getItem"),
      key: refuse("key"),
      removeItem: refuse("removeItem"),
      setItem: refuse("setItem"),
    },
  });
  try {
    await restoreStore();
    const view = mount();
    expect(view.getByRole("table")).toBeDefined();
    expect(shell(view.container).dataset["textMode"]).toBe("wrap");
    fireEvent.click(view.getByRole("button", { name: "Single line" }));
    // The choice still holds for the session, in memory.
    expect(shell(view.container).dataset["textMode"]).toBe("single-line");
    expect(calls).toContain("getItem");
    expect(calls).toContain("setItem");
  } finally {
    restoreLocalStorage(original);
  }
});

test("storage whose accessor throws leaves tables working", async () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: () => {
      throw new DOMException("Blocked", "SecurityError");
    },
  });
  try {
    await restoreStore();
    const view = mount();
    fireEvent.click(view.getByRole("button", { name: "Single line" }));
    expect(shell(view.container).dataset["textMode"]).toBe("single-line");
  } finally {
    restoreLocalStorage(original);
  }
});

test("the table's text formats keep cells, quotes and separators intact", () => {
  const view = mount();
  const table = view.getByRole("table");
  if (!(table instanceof HTMLTableElement)) {
    throw new TypeError("No table element");
  }
  expect(answerTableText(table, "md").split("\n").slice(0, 3)).toEqual([
    "| Provision | What it requires |",
    "| --- | --- |",
    "| Limitation of liability | Caps liability at twelve months of fees |",
  ]);
  const csv = answerTableText(table, "csv").split("\n");
  expect(csv.at(0)).toBe("Provision,What it requires");
  expect(csv.at(2)).toBe('Termination,"30 days\' notice, ""no reason"""');
  expect(answerTableText(table, "tsv").split("\n").at(4)).toBe(
    "Price\tCPI, plus two points",
  );
});

test("copy and download write the table in the chosen format", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        written.push(text);
        await Promise.resolve();
      },
    },
  });
  const downloads: Blob[] = [];
  const createObjectURL = spyOn(URL, "createObjectURL").mockImplementation(
    (blob) => {
      if (blob instanceof Blob) {
        downloads.push(blob);
      }
      return "blob:answer-table";
    },
  );
  const revokeObjectURL = spyOn(URL, "revokeObjectURL").mockImplementation(
    () => undefined,
  );
  try {
    const view = mount();
    fireEvent.click(view.getByRole("button", { name: "Copy table" }));
    fireEvent.click(await view.findByRole("menuitem", { name: "Copy as CSV" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written.at(0)?.split("\n").at(0)).toBe("Provision,What it requires");
    await view.findByRole("button", { name: "Copied" });

    fireEvent.click(view.getByRole("button", { name: "Download table" }));
    fireEvent.click(
      await view.findByRole("menuitem", { name: "Download as Markdown" }),
    );
    expect(downloads).toHaveLength(1);
    expect(downloads.at(0)?.type).toBe("text/markdown");
    expect((await downloads.at(0)?.text())?.split("\n").at(0)).toBe(
      "| Provision | What it requires |",
    );
  } finally {
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  }
});

test("full screen shows the same table, with its own copy and download", async () => {
  const view = mount();
  fireEvent.click(view.getByRole("button", { name: "Open full screen" }));
  const dialog = await view.findByRole("dialog", { name: "Full-screen table" });
  expect(dialog.querySelector("table")?.textContent).toContain(
    "Limitation of liability",
  );
  expect(dialog.textContent).toContain("4 rows · 2 columns");
  expect(dialog.querySelector('[aria-label="Copy table"]')).not.toBeNull();
  expect(dialog.querySelector('[aria-label="Open full screen"]')).toBeNull();
});
