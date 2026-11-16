import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const testing = await import("@testing-library/react");
const { SuggestionPieceLabel } =
  await import("../src/activity/SuggestionPieceLabel");

afterEach(() => {
  testing.cleanup();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const MATTER = "Due diligence – Alfa Holding";

const renderLabel = () => {
  const { container } = testing.render(
    <SuggestionPieceLabel
      duration="16 min"
      matter={MATTER}
      range="15:40–15:56"
    />,
  );
  const part = (name: string) => {
    const element = container.querySelector(`[data-part="${name}"]`);
    if (!(element instanceof HTMLElement)) {
      throw new TypeError(`The label has no ${name} part`);
    }
    return element;
  };
  return { container, part };
};

const classes = (element: HTMLElement) => element.className.split(/\s+/u);

describe("a suggestion piece's label", () => {
  test("reads as the matter, then the piece's range and minutes", () => {
    const { container } = renderLabel();
    expect(container.textContent.replaceAll(" ", " ")).toBe(
      `${MATTER} · 15:40–15:56 · 16 min`,
    );
  });

  test("ellipsises the matter and keeps the time whole", () => {
    const { part } = renderLabel();
    expect(part("matter").textContent).toBe(MATTER);
    expect(classes(part("matter"))).toEqual(
      expect.arrayContaining(["min-w-0", "truncate"]),
    );
    const time = part("time");
    expect(classes(time)).toEqual(
      expect.arrayContaining(["shrink-0", "whitespace-nowrap"]),
    );
    expect(time.contains(part("range"))).toBe(true);
    expect(time.contains(part("duration"))).toBe(true);
    expect(time.contains(part("matter"))).toBe(false);
  });

  test("drops the range on a narrow piece and keeps the minutes", () => {
    const { part } = renderLabel();
    const narrowOnly = (element: HTMLElement) =>
      classes(element).filter((name) => name.startsWith("@max-"));
    expect(narrowOnly(part("range"))).toEqual(["@max-[120px]:hidden"]);
    expect(narrowOnly(part("duration"))).toEqual([]);
    expect(part("duration").textContent).toBe("16 min");
  });
});
