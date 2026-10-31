import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { setImmediate as nextMacrotask } from "node:timers/promises";

GlobalRegistrator.register();
const previousActEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { EntityActions, EntityActionsButton } = await import("./entity-actions");

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});

afterAll(async () => {
  // React's scheduler runs its queued tasks on the next macrotasks; let them
  // run while the DOM globals still exist.
  await nextMacrotask();
  await nextMacrotask();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  await GlobalRegistrator.unregister();
});

type Actions = Parameters<typeof EntityActions>[0]["actions"];

const actionsFor = (onRename: () => void): Actions => [
  { label: "Rename", onClick: onRename },
  { label: "Move to…", submenu: [{ label: "Archive" }] },
  { label: "Pinned", checked: true },
  { label: "Delete", variant: "destructive", separatorBefore: true },
];

const openMenuLabels = () =>
  Array.from(
    document.querySelectorAll(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
    ),
    (item) => item.textContent.trim(),
  );

const closeMenus = async () => {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
  });
  await waitFor(() => {
    expect(openMenuLabels()).toEqual([]);
  });
};

/** A row with a name, an input, a link and its "…" button, like a real object. */
const Row = ({ actions, heading }: { actions: Actions; heading?: string }) => (
  <EntityActions actions={actions} heading={heading} label="Actions">
    <div data-testid="row">
      <span data-testid="name">Smlouva o dílo</span>
      <input aria-label="Note" data-testid="input" dir="ltr" />
      <textarea aria-label="Body" data-testid="textarea" dir="ltr" />
      <div contentEditable data-testid="editor" suppressContentEditableWarning>
        Draft{" "}
        <span contentEditable={false} data-testid="chip">
          chip
        </span>
      </div>
      <input aria-label="Done" data-testid="checkbox" type="checkbox" />
      <a data-testid="link" href="https://stll.app">
        stll.app
      </a>
      <EntityActionsButton />
    </div>
  </EntityActions>
);

const rightClick = (element: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    button: 2,
    cancelable: true,
    clientX: 40,
    clientY: 20,
    ...init,
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
};

describe("EntityActions", () => {
  test("the … button and right-click open the same items", async () => {
    const view = render(<Row actions={actionsFor(() => undefined)} />);

    fireEvent.click(view.getByRole("button", { name: "Actions" }));
    await waitFor(() => {
      expect(openMenuLabels().length).toBeGreaterThan(0);
    });
    const fromButton = openMenuLabels();
    await closeMenus();

    const event = rightClick(view.getByTestId("name"));
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(openMenuLabels().length).toBeGreaterThan(0);
    });
    const fromRightClick = openMenuLabels();

    // A toggle's item also carries its checked indicator's text.
    expect(fromButton).toEqual([
      "Rename",
      "Move to…",
      expect.stringContaining("Pinned"),
      "Delete",
    ]);
    expect(fromRightClick).toEqual(fromButton);
  });

  test("the heading shows above the actions in both menus", async () => {
    const view = render(
      <Row actions={actionsFor(() => undefined)} heading="Today 9:41" />,
    );
    fireEvent.click(view.getByRole("button", { name: "Actions" }));
    await waitFor(() => {
      expect(document.body.textContent).toContain("Today 9:41");
    });
    await closeMenus();
    rightClick(view.getByTestId("name"));
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="entity-actions-context-popup"]')
          ?.textContent,
      ).toContain("Today 9:41");
    });
  });

  test("a right-click item runs its action", async () => {
    const onRename = mock(() => undefined);
    const view = render(<Row actions={actionsFor(onRename)} />);
    rightClick(view.getByTestId("name"));
    await waitFor(() => {
      expect(openMenuLabels()).toContain("Rename");
    });
    const rename = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((item) => item.textContent.trim() === "Rename");
    if (rename === undefined) {
      throw new Error("Rename item missing");
    }
    fireEvent.click(rename);
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  test("the context-menu key opens the object's actions from the keyboard", async () => {
    const view = render(<Row actions={actionsFor(() => undefined)} />);
    const button = view.getByRole("button", { name: "Actions" });
    fireEvent.keyDown(button, { key: "ContextMenu" });
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="entity-actions-context-popup"]'),
      ).not.toBeNull();
    });
  });

  for (const [name, testId, init] of [
    ["Shift + right-click", "name", { shiftKey: true }],
    ["a right-click in an input", "input", {}],
    ["a right-click in a textarea", "textarea", {}],
    ["a right-click in editable text", "editor", {}],
    ["a right-click on a link", "link", {}],
  ] as const) {
    test(`${name} keeps the native menu`, async () => {
      const view = render(<Row actions={actionsFor(() => undefined)} />);
      const event = rightClick(view.getByTestId(testId), init);
      expect(event.defaultPrevented).toBe(false);
      // Give a wrongly opened menu the chance to mount before asserting.
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        document.querySelector('[data-slot="entity-actions-context-popup"]'),
      ).toBeNull();
    });
  }

  test("a right-click on selected text keeps the native menu", async () => {
    const view = render(<Row actions={actionsFor(() => undefined)} />);
    const name = view.getByTestId("name");
    const range = document.createRange();
    range.selectNodeContents(name);
    document.getSelection()?.addRange(range);

    const event = rightClick(name);
    expect(event.defaultPrevented).toBe(false);
  });

  test("a non-editable island and a checkbox still open the object's actions", () => {
    const view = render(<Row actions={actionsFor(() => undefined)} />);
    expect(rightClick(view.getByTestId("chip")).defaultPrevented).toBe(true);
    expect(rightClick(view.getByTestId("checkbox")).defaultPrevented).toBe(
      true,
    );
  });

  test("a nested object answers for itself, not the one around it", async () => {
    const view = render(
      <EntityActions actions={[{ label: "Open matter" }]} label="Matter">
        <div data-testid="matter">
          <EntityActions actions={[{ label: "Open file" }]} label="File">
            <span data-testid="file">contract.docx</span>
          </EntityActions>
        </div>
      </EntityActions>,
    );
    rightClick(view.getByTestId("file"));
    await waitFor(() => {
      expect(openMenuLabels()).toEqual(["Open file"]);
    });
  });

  test("a nested object with no actions keeps the native menu, not its parent's", async () => {
    const view = render(
      <EntityActions actions={[{ label: "Open matter" }]} label="Matter">
        <div data-testid="matter">
          <span data-testid="matter-name">Lease review</span>
          <EntityActions actions={[]} label="File">
            <span data-testid="file">contract.docx</span>
          </EntityActions>
        </div>
      </EntityActions>,
    );
    const onFile = rightClick(view.getByTestId("file"));
    expect(onFile.defaultPrevented).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(openMenuLabels()).toEqual([]);

    // The parent still answers for its own area.
    expect(rightClick(view.getByTestId("matter-name")).defaultPrevented).toBe(
      true,
    );
    await waitFor(() => {
      expect(openMenuLabels()).toEqual(["Open matter"]);
    });
  });

  test("no actions: no button, no menu, the native menu stays", () => {
    const view = render(<Row actions={[]} />);
    expect(view.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(rightClick(view.getByTestId("name")).defaultPrevented).toBe(false);
  });

  test("the … button outside its owner is a programming error", () => {
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<EntityActionsButton />)).toThrow(
        /inside EntityActions/u,
      );
    } finally {
      console.error = consoleError;
    }
  });
});
