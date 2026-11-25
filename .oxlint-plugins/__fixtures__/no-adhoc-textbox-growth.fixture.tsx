// Passive regression fixture for
// `no-adhoc-textbox-growth/no-adhoc-textbox-growth`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import type { ReactNode } from "react";

declare const Textarea: (props: { className?: string }) => ReactNode;
declare const PromptEditorContent: (props: { className?: string }) => ReactNode;
declare const cn: (...classes: unknown[]) => string;

// --- Flagged: field sizing by hand ---
// oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
export const _a = "field-sizing-content min-h-10";
// oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
export const _b = "[&_.ProseMirror]:field-sizing-fixed";

// --- Flagged: a cap through a selector that lands on the textbox ---
export const _c = () => (
  <PromptEditorContent
    // oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
    className="[&_.ProseMirror]:max-h-32 [&_.ProseMirror]:min-h-0"
  />
);
export const _d = () => (
  <div
    // oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
    className={cn("block w-full", "[&_textarea]:max-h-48")}
  />
);
// oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
export const _e = "[&>.tiptap]:overflow-y-auto";
// oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
export const _f = "[&_[contenteditable]]:overflow-auto";
// oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
export const _g = "[&_.ProseMirror:focus]:max-h-40";

// --- Flagged: a height cap on a textarea's own className ---
export const _h = () => (
  // oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
  <Textarea className="max-h-40 resize-none" />
);
export const _i = () => (
  // oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
  <textarea className={cn("w-full", "max-h-[12rem]")} />
);

// --- Flagged: an editor capping its own editable element ---
export const _j = {
  attributes: {
    // oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
    class: "max-h-48 overflow-y-auto text-sm",
  },
};
export const _k = {
  attributes: () => ({
    // oxlint-disable-next-line no-adhoc-textbox-growth/no-adhoc-textbox-growth
    class: "overflow-y-auto text-sm",
  }),
};

// --- Accepted: a floor and typography through the same selectors ---
export const _l =
  "[&_.ProseMirror]:min-h-15 [&_.ProseMirror]:leading-5 [&_.ProseMirror_p]:my-0";
// --- Accepted: a cap on something inside the editor, not the editor ---
export const _m = "[&_.ProseMirror_pre]:max-h-64 [&_.ProseMirror_pre]:overflow-x-auto";
// --- Accepted: caps on chrome that is not a textbox ---
// expect-clean: no-adhoc-textbox-growth/no-adhoc-textbox-growth
export const _n = () => <div className="max-h-80 overflow-hidden" />;
export const _o = { class: "max-h-48", attributes: { role: "textbox" } };
// --- Accepted: an editor's own classes that do not cap it ---
export const _p = {
  attributes: { class: "min-h-10 text-sm wrap-anywhere" },
};
