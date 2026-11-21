import { panic } from "better-result";

/** Document pages retain server offsets; portfolio previews open attached PDFs. */
export type PDFPageSource = "document" | "portfolio";

type ResolvePDFPageSourceOptions = {
  pageSource: PDFPageSource;
  documentPageCount: number;
  attachmentCount: number;
};

export const resolvePDFPageSource = ({
  pageSource,
  documentPageCount,
  attachmentCount,
}: ResolvePDFPageSourceOptions): PDFPageSource => {
  switch (pageSource) {
    case "document":
      return "document";
    case "portfolio":
      return documentPageCount <= 1 && attachmentCount > 0
        ? "portfolio"
        : "document";
    default:
      pageSource satisfies never;
      return panic("Unhandled PDF page source");
  }
};
