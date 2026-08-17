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

declare const buildDoc: (value: string) => unknown;

// Module-level fresh literal: evaluated once, stable by definition — the
// local-binding resolution must stop at function scopes and never flag it.
const moduleExtensions: unknown[] = [];

export const FlaggedFixture = ({ value }: { value: string }) => {
  // Local binding to a fresh literal in the same function body.
  const localProps = { attributes: { class: "y" } };
  const editor = useEditor({
    // Fresh array literal every render — MUST flag.
    // oxlint-disable-next-line require-stable-editor-options/require-stable-editor-options
    extensions: [],
    // Identifier resolving to a same-function fresh literal — MUST flag.
    // oxlint-disable-next-line require-stable-editor-options/require-stable-editor-options
    editorProps: localProps,
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

export const FlaggedInlineObjectFixture = () => {
  const editor = useEditor({
    // Fresh object literal every render — MUST flag.
    // oxlint-disable-next-line require-stable-editor-options/require-stable-editor-options
    editorProps: { attributes: { class: "x" } },
  });
  return editor;
};

export const SafeFixture = ({ value }: { value: string }) => {
  // Hook-captured bindings (destructured useState, useMemo result) and the
  // module constant above must NOT flag.
  const [content] = useState(() => buildDoc(value));
  const editorProps = useMemo(() => ({}), []);
  const editor = useEditor({
    autofocus: false,
    content,
    editorProps,
    extensions: moduleExtensions,
    onCreate: () => undefined,
    onUpdate: () => undefined,
  });
  return editor;
};
