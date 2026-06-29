import type { Ref } from "react";

import { DocxEditor as FolioDocxEditor } from "@stll/folio";
import type { DocxEditorProps, DocxEditorRef } from "@stll/folio";

import { folioUIComponents } from "@/lib/folio-ui-components";

export type { DocxEditorProps, DocxEditorRef } from "@stll/folio";

/**
 * App-bound `DocxEditor`: folio's editor with the app's design-system chrome
 * (`folioUIComponents`) pre-bound, so no render site can forget to inject the
 * override. This is the single source of truth for the binding; app code should
 * import `DocxEditor` from here rather than from `@stll/folio` directly. A
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
