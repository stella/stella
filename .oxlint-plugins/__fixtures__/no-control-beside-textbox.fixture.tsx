// Passive regression fixture for
// `no-control-beside-textbox/no-control-beside-textbox`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import type { ReactNode } from "react";

declare const Button: (props: { children?: ReactNode }) => ReactNode;
declare const Textarea: (props: { rows?: number }) => ReactNode;
declare const EditorContent: (props: { editor: null }) => ReactNode;
declare const PromptEditorContent: (props: { editor: null }) => ReactNode;
declare const ComposerPlusMenu: () => ReactNode;
declare const DialogTrigger: (props: { children?: ReactNode }) => ReactNode;
declare const DialogPopup: (props: { children?: ReactNode }) => ReactNode;
declare const SelectTrigger: (props: { children?: ReactNode }) => ReactNode;
declare const ComposerFrame: (props: {
  text: ReactNode;
  trailing: ReactNode;
}) => ReactNode;
declare const ReferenceRenderScope: (props: {
  children?: ReactNode;
}) => ReactNode;

const COMPACT_GRID = "grid grid-cols-[auto_minmax(0,1fr)_auto] items-end";

// --- Flagged: the text cell in a row beside its controls ---
export const _a = () => (
  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1">
    <ComposerPlusMenu />
    <div className="min-w-0 py-[11px]">
      <ReferenceRenderScope>
        {/* oxlint-disable-next-line no-control-beside-textbox/no-control-beside-textbox */}
        <PromptEditorContent editor={null} />
      </ReferenceRenderScope>
    </div>
    <span className="flex items-center gap-0.5">
      <Button>Send</Button>
    </span>
  </div>
);
export const _b = () => (
  <div className="relative flex w-full items-end">
    {/* oxlint-disable-next-line no-control-beside-textbox/no-control-beside-textbox */}
    <textarea />
    <button type="submit">Send</button>
  </div>
);
export const _c = () => (
  <div className={COMPACT_GRID}>
    {/* oxlint-disable-next-line no-control-beside-textbox/no-control-beside-textbox */}
    <EditorContent editor={null} />
    <Button>Send</Button>
  </div>
);
export const _d = () => (
  <div className="inline-flex gap-2">
    {/* oxlint-disable-next-line no-control-beside-textbox/no-control-beside-textbox */}
    <div contentEditable />
    <DialogTrigger>Open</DialogTrigger>
  </div>
);
export const _e = ({ canSend }: { canSend: boolean }) => (
  <div className="grid grid-cols-2">
    {/* oxlint-disable-next-line no-control-beside-textbox/no-control-beside-textbox */}
    <Textarea rows={2} />
    {canSend && <Button>Send</Button>}
  </div>
);

// --- Flagged: a control positioned over the text ---
export const _f = () => (
  <div className="relative">
    {/* oxlint-disable-next-line no-control-beside-textbox/no-control-beside-textbox */}
    <Textarea rows={3} />
    <div className="absolute end-1 bottom-1">
      <Button>Send</Button>
    </div>
  </div>
);
export const _g = () => (
  <div className="relative flex flex-col">
    {/* oxlint-disable-next-line no-control-beside-textbox/no-control-beside-textbox */}
    <PromptEditorContent editor={null} />
    <span className="sticky bottom-0">
      <Button>Send</Button>
    </span>
  </div>
);

// --- Accepted: the text over a control row ---
// expect-clean: no-control-beside-textbox/no-control-beside-textbox
export const _h = () => (
  <div className="flex flex-col">
    <Textarea rows={3} />
    <div className="flex items-center justify-end gap-1">
      <Button>Send</Button>
    </div>
  </div>
);
export const _i = () => (
  <div className="grid gap-2">
    <PromptEditorContent editor={null} />
    <Button>Send</Button>
  </div>
);

// --- Accepted: the textbox handed to a component as a prop ---
export const _j = () => (
  <ComposerFrame
    text={<PromptEditorContent editor={null} />}
    trailing={<Button>Send</Button>}
  />
);

// --- Accepted: a column beside page actions, a form field beside a field ---
export const _k = () => (
  <div className="flex items-start gap-4">
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Textarea rows={1} />
    </div>
    <Button>Preview</Button>
  </div>
);
export const _l = () => (
  <div className="flex items-start gap-2">
    <SelectTrigger>Kind</SelectTrigger>
    <Textarea rows={2} />
  </div>
);

// --- Accepted: a popup's content, a control anchored outside the box ---
export const _m = () => (
  <div className="flex flex-wrap gap-2">
    <DialogPopup>
      <Textarea rows={2} />
    </DialogPopup>
    <Button>Other dialog</Button>
  </div>
);
export const _n = () => (
  <div className="relative">
    <div className="absolute start-1 bottom-full mb-3">
      <Button>Preset</Button>
    </div>
    <Textarea rows={2} />
  </div>
);

// --- Accepted: a single-line input, an inline chip that is not editable ---
export const _o = () => (
  <div className="flex items-center gap-2">
    <input />
    <Button>Search</Button>
  </div>
);
export const _p = () => (
  <div className="flex items-center gap-2">
    <span contentEditable={false} />
    <Button>Remove</Button>
  </div>
);
