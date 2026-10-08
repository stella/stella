import { panic } from "better-result";

import {
  holdLanding,
  readerBlockByAnchor,
} from "@/components/legal-reader/reader-landing";

import type { decisionParagraphLanding } from "./decision-paragraph-landing.logic";

/** Synchronizes the resolved URL target with this reader's rendered paragraphs. */
export const applyDecisionParagraphLanding = (
  container: HTMLElement,
  paragraphLanding: ReturnType<typeof decisionParagraphLanding>,
) => {
  switch (paragraphLanding.type) {
    case "anchor":
    case "invalid":
    case "text-unavailable":
      return;
    case "not-found":
      container.scrollTo({ top: 0, behavior: "instant" });
      return;
    case "range":
      break;
    default:
      paragraphLanding satisfies never;
      return panic("Unhandled decision paragraph landing");
  }
  const targets = paragraphLanding.anchorIds.map((id) => {
    const target = readerBlockByAnchor(container, id);
    return target ?? panic("Resolved court paragraph must be rendered");
  });
  const target = readerBlockByAnchor(container, paragraphLanding.firstAnchorId);
  if (target === null) {
    return panic("First resolved court paragraph must be rendered");
  }
  for (const paragraph of targets) {
    for (
      let disclosure = paragraph.closest("details");
      disclosure !== null;
      disclosure = disclosure.parentElement?.closest("details") ?? null
    ) {
      disclosure.open = true;
    }
    paragraph.dataset["readerLanding"] = "";
    paragraph.classList.add("bg-accent", "text-accent-foreground");
  }
  const previousTabIndex = target.getAttribute("tabindex");
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  const article =
    target.closest("article") ??
    panic("Court paragraph must belong to the reader article");
  const release = holdLanding({ article, target });
  return () => {
    release();
    for (const paragraph of targets) {
      delete paragraph.dataset["readerLanding"];
      paragraph.classList.remove("bg-accent", "text-accent-foreground");
    }
    if (previousTabIndex === null) {
      target.removeAttribute("tabindex");
    } else {
      target.setAttribute("tabindex", previousTabIndex);
    }
  };
};
