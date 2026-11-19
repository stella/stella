// Passive regression fixture for `copy-feedback-owner/copy-feedback-owner`,
// `copy-feedback-owner/no-raw-copy-listener` and
// `copy-feedback-owner/no-raw-clipboard-write`.
//
// `oxlint-disable-next-line` directives suppress cases the rules MUST flag; if
// a rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

// oxlint-disable-next-line copy-feedback-owner/copy-feedback-owner -- regression fixture for a hand-rolled Copy and Copied swap
import { CopyFeedback } from "@stll/ui/copy-button";

// expect-clean: copy-feedback-owner/copy-feedback-owner
const { COPIED_RESET_MS } = await import("@stll/ui/copy-button");

declare const confirm: () => void;
declare const host: HTMLElement;
// The rule reads the command by name; a stand-in keeps the fixture off the
// deprecated DOM method.
declare const editor: { execCommand: (command: string) => boolean };
declare const copyNoticeText: () => Promise<boolean>;
declare const NoticeCopy: (props: {
  onCopy: () => Promise<boolean>;
}) => null;

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

// --- Flagged: a raw clipboard write ---
export const _c = async () =>
  // oxlint-disable-next-line copy-feedback-owner/no-raw-clipboard-write -- regression fixture for a direct clipboard write
  await navigator.clipboard.writeText("Smlouva o dílo");
// oxlint-disable-next-line copy-feedback-owner/no-raw-clipboard-write -- regression fixture for the legacy copy command
export const _d = () => editor.execCommand("copy");

// --- Accepted: other events, a component's own onCopy prop ---
// expect-clean: copy-feedback-owner/no-raw-copy-listener
host.addEventListener("selectionchange", confirm);
export const _e = () => (
  // expect-clean: copy-feedback-owner/no-raw-copy-listener
  <NoticeCopy onCopy={copyNoticeText} />
);
// expect-clean: copy-feedback-owner/no-raw-clipboard-write
export const _f = () => editor.execCommand("bold");
export const _g = COPIED_RESET_MS;
export const _h = CopyFeedback;
