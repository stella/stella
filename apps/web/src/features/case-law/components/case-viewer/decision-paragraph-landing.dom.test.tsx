import { useRef } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import {
  applyDecisionParagraphLanding,
  useDecisionParagraphLanding,
} from "./decision-paragraph-landing";

GlobalRegistrator.register();
const { render, cleanup } = await import("@testing-library/react");
afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const fixture = () => {
  const { container } = render(null);
  container.innerHTML =
    '<article><p data-anchor="p-1">Before</p><details><summary>Text</summary><p data-anchor="p-12" /><p data-anchor="p-13">Last</p></details></article>';
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

test("valid missing ranges hold the start instead of retaining a stale passage", () => {
  const { container } = fixture();
  const scroll = mock(() => {});
  container.scrollTo = scroll;
  const release = applyDecisionParagraphLanding(container, {
    type: "not-found",
    range: { from: 48, to: 53 },
  });
  expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
  expect(
    container.querySelectorAll<HTMLElement>("[data-reader-landing]").length,
  ).toBe(0);
  // The router restores the previous position after a hash navigation renders.
  container.dispatchEvent(new Event("scroll"));
  expect(scroll).toHaveBeenCalledTimes(2);
  // Once the reader scrolls on their own, the start is no longer held.
  container.ownerDocument.dispatchEvent(new Event("wheel"));
  container.dispatchEvent(new Event("scroll"));
  expect(scroll).toHaveBeenCalledTimes(2);
  release?.();
});

test("a range landing lands again when something else scrolls the reader", () => {
  const { container, first } = fixture();
  const scroll = mock(() => {});
  first.scrollIntoView = scroll;
  const release = applyDecisionParagraphLanding(container, {
    type: "range",
    range: { from: 48, to: 49 },
    anchorIds: ["p-12", "p-13"],
    firstAnchorId: "p-12",
  });
  expect(scroll).toHaveBeenCalledTimes(1);
  container.ownerDocument.dispatchEvent(new Event("scroll"));
  expect(scroll).toHaveBeenCalledTimes(2);
  release?.();
  container.ownerDocument.dispatchEvent(new Event("scroll"));
  expect(scroll).toHaveBeenCalledTimes(2);
});

for (const landing of [
  { type: "invalid" },
  { type: "text-unavailable" },
] as const) {
  test(`${landing.type} leaves the normal reader untouched`, () => {
    const { container, first } = fixture();
    const scroll = mock(() => {});
    container.scrollTo = scroll;
    first.focus();
    const activeElement = container.ownerDocument.activeElement;
    expect(applyDecisionParagraphLanding(container, landing)).toBeUndefined();
    expect(scroll).not.toHaveBeenCalled();
    expect(container.ownerDocument.activeElement).toBe(activeElement);
    expect(container.querySelectorAll("[data-reader-landing]").length).toBe(0);
  });
}

const storedAst = {
  version: 1,
  source: { system: "", documentId: "", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      type: "paragraph",
      id: "b-12",
      plainText: "First",
      anchorId: "p-12",
      number: 48,
      inlines: [{ type: "text", text: "First" }],
    },
    {
      type: "paragraph",
      id: "b-13",
      plainText: "Second",
      anchorId: "p-13",
      number: 49,
      inlines: [{ type: "text", text: "Second" }],
    },
  ],
} satisfies DocumentAst;

type LandingHarnessProps = {
  documentAst: unknown;
  fragment: string;
  label: string;
};

const LandingHarness = ({
  documentAst,
  fragment,
  label,
}: LandingHarnessProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useDecisionParagraphLanding({ containerRef, documentAst, fragment });
  return (
    <div ref={containerRef}>
      <button type="button">{label}</button>
      <article>
        <p data-anchor="p-12" />
        <p data-anchor="p-13" />
      </article>
    </div>
  );
};

test("lands once per stored AST and fragment, not on every render", () => {
  const scroll = mock(() => {});
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const { container, getByRole, rerender } = render(
      <LandingHarness documentAst={storedAst} fragment="par=48" label="a" />,
    );
    const first = container.querySelector<HTMLElement>('[data-anchor="p-12"]');
    expect(container.ownerDocument.activeElement).toBe(first);
    expect(scroll).toHaveBeenCalledTimes(1);

    const elsewhere = getByRole("button");
    elsewhere.focus();
    scroll.mockClear();
    rerender(
      <LandingHarness documentAst={storedAst} fragment="par=48" label="b" />,
    );
    expect(scroll).not.toHaveBeenCalled();
    expect(container.ownerDocument.activeElement).toBe(elsewhere);
    expect(first?.dataset["readerLanding"]).toBe("");

    rerender(
      <LandingHarness documentAst={storedAst} fragment="par=49" label="b" />,
    );
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(container.ownerDocument.activeElement).toBe(
      container.querySelector('[data-anchor="p-13"]'),
    );
    expect(first?.dataset["readerLanding"]).toBeUndefined();
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});
