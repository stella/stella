import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { KanbanCardShell } from "./card-shell";

GlobalRegistrator.register({ url: "https://example.test" });
const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");

afterEach(() => cleanup());
afterAll(async () => GlobalRegistrator.unregister());

const renderCard = (
  props: Partial<Parameters<typeof KanbanCardShell>[0]> = {},
) => {
  const onOpen = mock(() => undefined);
  const onSelectionClick = mock(() => undefined);
  render(
    <KanbanCardShell
      onOpen={onOpen}
      onSelectionClick={onSelectionClick}
      {...props}
    >
      <p>Card body</p>
    </KanbanCardShell>,
  );
  return {
    card: screen.getByRole("button"),
    onOpen,
    onSelectionClick,
  };
};

describe("KanbanCardShell selection clicks", () => {
  test("a plain click opens the card", () => {
    const { card, onOpen, onSelectionClick } = renderCard();

    fireEvent.click(card);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onSelectionClick).not.toHaveBeenCalled();
  });

  test("Cmd, Ctrl and Shift clicks change the selection instead of opening", () => {
    const { card, onOpen, onSelectionClick } = renderCard();

    fireEvent.click(card, { metaKey: true });
    fireEvent.click(card, { ctrlKey: true });
    fireEvent.click(card, { shiftKey: true });

    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelectionClick.mock.calls).toEqual([
      [{ meta: true, shift: false }],
      [{ meta: true, shift: false }],
      [{ meta: false, shift: true }],
    ]);
  });

  test("a modified click opens the card on a board without selection", () => {
    const { card, onOpen } = renderCard({ onSelectionClick: undefined });

    fireEvent.click(card, { metaKey: true });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("a selected card is marked for the board and draws the selection ring", () => {
    const { card } = renderCard({ active: true, selected: true });
    const wrapper = card.parentElement;

    expect(wrapper?.dataset.kanbanCard).toBe("");
    expect(wrapper?.dataset.selected).toBe("true");
    expect(card.className).toContain("ring-primary ");
    expect(card.className).not.toContain("ring-primary/30");
  });
});
