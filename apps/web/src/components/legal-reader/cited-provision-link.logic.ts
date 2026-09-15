import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";

/** What a click on a cited provision does. */
export const CITED_PROVISION_CLICK = {
  /** Fold the wording away again. */
  collapse: "collapse",
  /** Show the wording where the citation stands, without leaving the text. */
  expand: "expand",
  /** A browser navigation gesture keeps the meaning the browser gives it. */
  navigate: "navigate",
} as const;

export type CitedProvisionClick =
  (typeof CITED_PROVISION_CLICK)[keyof typeof CITED_PROVISION_CLICK];

type CitedProvisionClickArgs = {
  /** Whether the wording is already open under this citation. */
  expanded: boolean;
  gesture: Parameters<typeof isPlainPrimaryClick>[0];
  /**
   * False where nothing can unfold beside the text — a single-column
   * viewport — so the citation is a plain link there.
   */
  expandsInPlace: boolean;
};

/**
 * A plain primary click is a reader asking what the provision says, not
 * asking to leave the decision: it unfolds the wording in the paragraph, and
 * a second one folds it away. A modified or middle click is a request for a
 * tab or a window, so it stays native and goes to the statute reader.
 */
export const citedProvisionClick = ({
  expanded,
  expandsInPlace,
  gesture,
}: CitedProvisionClickArgs): CitedProvisionClick => {
  if (!expandsInPlace || !isPlainPrimaryClick(gesture)) {
    return CITED_PROVISION_CLICK.navigate;
  }

  return expanded
    ? CITED_PROVISION_CLICK.collapse
    : CITED_PROVISION_CLICK.expand;
};
