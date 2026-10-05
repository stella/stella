import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act } = await import("react");
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { DockedComposer } = await import("@/components/chat/docked-composer");
const { DockedChatStackProvider, DockedChatSurface } =
  await import("@/components/chat/docked-chat-stack");

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Position in the document, so "above the bar" is checked as a fact. */
const orderIn = (root: Element, element: Element) =>
  [...root.querySelectorAll("*")].indexOf(element);

describe("docked chat stack", () => {
  test("the thread card and review pill dock in the composer column, above the bar", async () => {
    // The surfaces render as siblings of the composer, the way the file
    // overlay mounts them, and still land inside its column.
    const view = render(
      <DockedChatStackProvider>
        <DockedChatSurface slot="thread">
          <div data-testid="thread" />
        </DockedChatSurface>
        <DockedChatSurface slot="review">
          <div data-testid="review" />
        </DockedChatSurface>
        <DockedComposer bar={<div data-testid="bar" />} />
      </DockedChatStackProvider>,
    );

    const thread = await waitFor(() => view.getByTestId("thread"));
    const review = view.getByTestId("review");
    const bar = view.getByTestId("bar");
    const column = view.container.querySelector(
      '[data-slot="docked-chat-thread"]',
    )?.parentElement;

    expect(column).toBeDefined();
    expect(column?.contains(thread)).toBe(true);
    expect(column?.contains(review)).toBe(true);
    expect(column?.contains(bar)).toBe(true);
    const root = view.container;
    expect(orderIn(root, thread)).toBeLessThan(orderIn(root, review));
    expect(orderIn(root, review)).toBeLessThan(orderIn(root, bar));
  });

  test("an empty slot takes no room in the column", () => {
    const view = render(
      <DockedChatStackProvider>
        <DockedComposer bar={<div data-testid="bar" />} />
      </DockedChatStackProvider>,
    );

    const slot = view.container.querySelector(
      '[data-slot="docked-chat-thread"]',
    );
    expect(slot?.className).toContain("empty:hidden");
    expect(slot?.childElementCount).toBe(0);
  });

  test("a docked surface without a host stack fails instead of vanishing", () => {
    expect(() =>
      render(
        <DockedChatSurface slot="thread">
          <div />
        </DockedChatSurface>,
      ),
    ).toThrow("DockedChatStackProvider");
  });
});
