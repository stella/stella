// Passive regression fixture for `copy-feedback-owner/copy-feedback-owner` and
// `copy-feedback-owner/no-raw-copy-listener`.
//
// `oxlint-disable-next-line` directives suppress cases the rules MUST flag; if
// a rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

// oxlint-disable-next-line copy-feedback-owner/copy-feedback-owner -- regression fixture for a hand-rolled Copy and Copied swap
import { CopyFeedback } from "@stll/ui/copy-button";

// expect-clean: copy-feedback-owner/copy-feedback-owner
const { CopyButton } = await import("@stll/ui/copy-button");

declare const confirm: () => void;
declare const host: HTMLElement;
declare const copyNoticeText: () => Promise<boolean>;

// --- Flagged: a hand-written native copy listener ---
export const _a = () => (
  // oxlint-disable-next-line copy-feedback-owner/no-raw-copy-listener -- regression fixture for a JSX copy handler
  <p onCopy={confirm}>Smlouva o dílo</p>
);
export const _b = () => (
  // oxlint-disable-next-line copy-feedback-owner/no-raw-copy-listener -- regression fixture for a capture-phase JSX copy handler
  <p onCopyCapture={confirm}>Smlouva o dílo</p>
);
// oxlint-disable-next-line copy-feedback-owner/no-raw-copy-listener -- regression fixture for a DOM copy listener
host.ownerDocument.addEventListener("copy", confirm);

// --- Accepted: other events, a component's own onCopy prop ---
// expect-clean: copy-feedback-owner/no-raw-copy-listener
host.addEventListener("selectionchange", confirm);
export const _c = () => (
  // expect-clean: copy-feedback-owner/no-raw-copy-listener
  <CopyButton copiedLabel="Copied" label="Copy" onCopy={copyNoticeText} />
);
export const _d = CopyFeedback;
