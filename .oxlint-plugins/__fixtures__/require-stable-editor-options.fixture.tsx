// Passive regression fixture for
// `require-stable-editor-options/require-stable-editor-options`.
//
// Each `oxlint-disable-next-line` below suppresses an option the rule MUST
// flag. If the rule regresses, the matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The safe
// call at the end carries no disable, so the rule over-firing on it also
// fails CI.

import { useMemo, useState } from "react";

import { useEditor } from "@tiptap/react";

declare const stableExtensions: unknown[];
declare const buildDoc: (value: string) => unknown;

export const FlaggedFixture = ({ value }: { value: string }) => {
  const editor = useEditor({
    // Fresh array literal every render — MUST flag.
    // oxlint-disable-next-line require-stable-editor-options/require-stable-editor-options
    extensions: [],
    // Fresh object literal every render — MUST flag.
    // oxlint-disable-next-line require-stable-editor-options/require-stable-editor-options
    editorProps: { attributes: { class: "x" } },
    // Fresh call result every render — MUST flag.
    // oxlint-disable-next-line require-stable-editor-options/require-stable-editor-options
    content: buildDoc(value),
    // Conditional with a fresh branch — MUST flag.
    // oxlint-disable-next-line require-stable-editor-options/require-stable-editor-options
    autofocus: value ? { start: true } : false,
    // Handler keys are excluded from the identity comparison — must NOT flag.
    onUpdate: () => undefined,
  });
  return editor;
};

export const SafeFixture = ({ value }: { value: string }) => {
  const [content] = useState(() => buildDoc(value));
  const editorProps = useMemo(() => ({}), []);
  const editor = useEditor({
    autofocus: false,
    content,
    editorProps,
    extensions: stableExtensions,
    onCreate: () => undefined,
    onUpdate: () => undefined,
  });
  return editor;
};
