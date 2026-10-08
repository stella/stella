import type { RefObject } from "react";

import { panic } from "better-result";

import { parseDocumentAst } from "@stll/legal-ast/document-ast";

import {
  holdLanding,
  readerBlockByAnchor,
} from "@/components/legal-reader/reader-landing";
import { useExternalSyncEffect } from "@/hooks/use-effect";

import { decisionParagraphLanding } from "./decision-paragraph-landing.logic";

/** Synchronizes the resolved URL target with this reader's rendered paragraphs. */
export const applyDecisionParagraphLanding = (
  container: HTMLElement,
  paragraphLanding: ReturnType<typeof decisionParagraphLanding>,
) => {
  switch (paragraphLanding.type) {
    case "anchor":
    case "invalid":
    case "text-unavailable":
      return undefined;
    case "not-found":
      container.scrollTo({ top: 0, behavior: "instant" });
      return undefined;
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

type DecisionParagraphLandingSyncOptions = {
  containerRef: RefObject<HTMLElement | null>;
  /** The decision's stored AST; its reference, not a per-render parse, keys the landing. */
  documentAst: unknown;
  fragment: string | undefined;
};

/**
 * Lands once per stored AST and fragment. Keyed on those inputs rather than
 * a derived landing object, so an unrelated render never refocuses or
 * rescrolls a reader who has moved on.
 */
export const useDecisionParagraphLanding = ({
  containerRef,
  documentAst,
  fragment,
}: DecisionParagraphLandingSyncOptions) => {
  useExternalSyncEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return undefined;
    }
    return applyDecisionParagraphLanding(
      container,
      decisionParagraphLanding(parseDocumentAst(documentAst), fragment),
    );
  }, [containerRef, documentAst, fragment]);
};
