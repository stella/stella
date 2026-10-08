import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { applyDecisionParagraphLanding } from "./decision-paragraph-landing";

GlobalRegistrator.register();
const { render, cleanup } = await import("@testing-library/react");
afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const fixture = () => {
  const { container } = render(null);
  container.innerHTML =
    '<article><p data-anchor="p-1">Before</p><details><summary>Text</summary><p data-anchor="p-12">First</p><p data-anchor="p-13">Last</p></details></article>';
  const first = container.querySelector<HTMLElement>('[data-anchor="p-12"]');
  if (first === null) {
    throw new Error("Expected first fixture paragraph");
  }
  return { container, first };
};

test("highlights the complete range, reveals folded text, focuses and scrolls to its first paragraph", () => {
  const { container, first } = fixture();
  const scroll = mock(() => {});
  first.scrollIntoView = scroll;
  const release = applyDecisionParagraphLanding(container, {
    type: "range",
    range: { from: 48, to: 49 },
    anchorIds: ["p-12", "p-13"],
    firstAnchorId: "p-12",
  });
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-reader-landing]")].map(
      (node) => node.dataset["anchor"],
    ),
  ).toEqual(["p-12", "p-13"]);
  for (const node of container.querySelectorAll<HTMLElement>(
    "[data-reader-landing]",
  )) {
    expect(node.classList.contains("bg-accent")).toBe(true);
    expect(node.classList.contains("text-accent-foreground")).toBe(true);
  }
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.ownerDocument.activeElement).toBe(first);
  expect(first.tabIndex).toBe(-1);
  expect(scroll).toHaveBeenCalledWith({
    behavior: "instant",
    block: "center",
    inline: "nearest",
  });
  release?.();
  expect(
    container.querySelectorAll<HTMLElement>("[data-reader-landing]").length,
  ).toBe(0);
  expect(container.querySelectorAll(".bg-accent").length).toBe(0);
  expect(first.hasAttribute("tabindex")).toBe(false);
});

test("unavailable ranges scroll to the start instead of retaining a stale passage", () => {
  const { container } = fixture();
  const scroll = mock(() => {});
  container.scrollTo = scroll;
  applyDecisionParagraphLanding(container, { type: "unavailable" });
  expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
  expect(
    container.querySelectorAll<HTMLElement>("[data-reader-landing]").length,
  ).toBe(0);
});
