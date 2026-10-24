/**
 * How the original view renders the file viewer that loads and paints the
 * DOCX, given that viewer's own props. By default it is the Folio-backed file
 * viewer; a test provides a host that delivers a document to the
 * `docxPlugins` it is handed and paints its runs without laying out real
 * pages.
 */

import { createContext } from "react";
import type { ComponentProps, ReactNode } from "react";

import { PeekPdfViewer } from "@/components/pdf/peek/peek-pdf-viewer";

export type OriginalDocxHostProps = ComponentProps<typeof PeekPdfViewer>;

export const OriginalDocxHostContext = createContext<
  (props: OriginalDocxHostProps) => ReactNode
>((props) => <PeekPdfViewer {...props} />);
