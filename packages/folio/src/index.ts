// `@stll/folio` is the React adapter. It re-exports the entire headless core
// (also importable standalone, React-free, at `@stll/folio/core`) and adds the
// React components on top.

export * from "./core";

export { DocxEditor } from "./components/DocxEditor";
export type {
  DocxEditorCollaboration,
  DocxEditorProps,
  DocxEditorRef,
} from "./components/DocxEditor.props";
export type { EditorMode } from "./components/hooks/useEditorMode";
export {
  FormattingBar,
  type FormattingBarProps,
} from "./components/FormattingBar";
export {
  AutocompleteCaretOverlay,
  type AutocompleteCaretOverlayProps,
  type AutocompleteCaretRect,
} from "./paged-editor/AutocompleteCaretOverlay";
