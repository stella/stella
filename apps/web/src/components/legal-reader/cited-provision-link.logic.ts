import { isPlainPrimaryClick } from "@/components/inspector/case-decision-view";

/** What a click on a cited provision does. */
export const CITED_PROVISION_CLICK = {
  peek: "peek",
  /** A browser navigation gesture keeps the meaning the browser gives it. */
  navigate: "navigate",
} as const;

/** A plain click keeps the preview open even when hover already opened it. */
export const citedProvisionClick = (
  gesture: Parameters<typeof isPlainPrimaryClick>[0],
) =>
  isPlainPrimaryClick(gesture)
    ? CITED_PROVISION_CLICK.peek
    : CITED_PROVISION_CLICK.navigate;
