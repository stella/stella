import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";

/** What a click on a link to a cited decision does. */
export const CITED_DECISION_CLICK = {
  /** A browser navigation gesture keeps the meaning the browser gives it. */
  navigate: "navigate",
  /** Show what the citing text says, and offer to open the decision. */
  preview: "preview",
} as const;

export type CitedDecisionClick =
  (typeof CITED_DECISION_CLICK)[keyof typeof CITED_DECISION_CLICK];

type ClickGesture = Parameters<typeof isPlainPrimaryClick>[0];

/**
 * A plain primary click is a reader asking about the citation, not asking to
 * leave the text: it opens the preview, and opening the decision is a
 * separate, explicit action from there. A modified or middle click is a
 * request for a tab or a window, so it stays native and goes straight there.
 */
export const citedDecisionClick = (
  gesture: ClickGesture,
): CitedDecisionClick =>
  isPlainPrimaryClick(gesture)
    ? CITED_DECISION_CLICK.preview
    : CITED_DECISION_CLICK.navigate;
