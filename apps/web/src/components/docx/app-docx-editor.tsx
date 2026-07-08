import type { Ref } from "react";

import { DocxEditor as FolioDocxEditor } from "@stll/folio-react";
import type { DocxEditorProps, DocxEditorRef } from "@stll/folio-react";

import { folioUIComponents } from "@/lib/folio-ui-components";

export type { DocxEditorProps, DocxEditorRef } from "@stll/folio-react";

/**
 * The controlled `comments` array `DocxEditor` reads and emits through
 * `onCommentsChange`. Derived from the prop so app code (the file-chat comment
 * tools) can type its comment-state round-trip without importing folio-core's
 * `Comment` directly (web depends on `@stll/folio-react`, not `folio-core`).
 */
export type DocxComments = NonNullable<DocxEditorProps["comments"]>;

/**
 * App-bound `DocxEditor`: folio's editor with the app's design-system chrome
 * (`folioUIComponents`) pre-bound, so no render site can forget to inject the
 * override. This is the single source of truth for the binding; app code should
 * import `DocxEditor` from here rather than from `@stll/folio-react` directly. A
 * caller may still override individual primitives by passing its own
 * `components`, which take precedence over the shared override.
 */
export function DocxEditor(
  props: DocxEditorProps & { ref?: Ref<DocxEditorRef> },
) {
  return (
    <FolioDocxEditor
      {...props}
      components={{ ...folioUIComponents, ...props.components }}
    />
  );
}
