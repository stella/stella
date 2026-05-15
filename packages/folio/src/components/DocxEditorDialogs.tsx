import { Suspense, lazy } from "react";

import type {
  EndnoteProperties,
  FootnoteProperties,
  SectionProperties,
} from "../core/types/document";
import type {
  FindMatch,
  FindOptions,
  FindResult,
} from "./dialogs/findReplaceUtils";
import type { ImagePositionData } from "./dialogs/ImagePositionDialog";
import type { ImagePropertiesData } from "./dialogs/ImagePropertiesDialog";
import type { TableProperties } from "./dialogs/TablePropertiesDialog";
import type { UseFindReplaceReturn } from "./dialogs/useFindReplace";

const FindReplaceDialog = lazy(() =>
  import("./dialogs/FindReplaceDialog").then((m) => ({
    default: m.FindReplaceDialog,
  })),
);
const TablePropertiesDialog = lazy(() =>
  import("./dialogs/TablePropertiesDialog").then((m) => ({
    default: m.TablePropertiesDialog,
  })),
);
const ImagePositionDialog = lazy(() =>
  import("./dialogs/ImagePositionDialog").then((m) => ({
    default: m.ImagePositionDialog,
  })),
);
const ImagePropertiesDialog = lazy(() =>
  import("./dialogs/ImagePropertiesDialog").then((m) => ({
    default: m.ImagePropertiesDialog,
  })),
);
const FootnotePropertiesDialog = lazy(() =>
  import("./dialogs/FootnotePropertiesDialog").then((m) => ({
    default: m.FootnotePropertiesDialog,
  })),
);
const PageSetupDialog = lazy(() =>
  import("./dialogs/PageSetupDialog").then((m) => ({
    default: m.PageSetupDialog,
  })),
);

export type FindReplaceMount = {
  state: UseFindReplaceReturn["state"];
  onClose: () => void;
  onFind: (searchText: string, options: FindOptions) => FindResult | null;
  onFindNext: () => FindMatch | null;
  onFindPrevious: () => FindMatch | null;
  onReplace: (replaceText: string) => boolean;
  onReplaceAll: (
    searchText: string,
    replaceText: string,
    options: FindOptions,
  ) => number;
  currentResult: FindResult | null;
};

export type TablePropertiesMount = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (props: TableProperties) => void;
  currentProps: Record<string, unknown> | undefined;
};

export type ImagePositionMount = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (data: ImagePositionData) => void;
};

export type ImagePropertiesMount = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (data: ImagePropertiesData) => void;
  currentData: ImagePropertiesData | undefined;
};

export type PageSetupMount = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (props: Partial<SectionProperties>) => void;
  currentProps: SectionProperties | undefined;
};

export type FootnotePropertiesMount = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (
    footnotePr: FootnoteProperties,
    endnotePr: EndnoteProperties,
  ) => void;
  footnotePr: FootnoteProperties | undefined;
  endnotePr: EndnoteProperties | undefined;
};

export type DocxEditorDialogsProps = {
  findReplace: FindReplaceMount;
  tableProperties: TablePropertiesMount;
  imagePosition: ImagePositionMount;
  imageProperties: ImagePropertiesMount;
  pageSetup: PageSetupMount;
  footnoteProperties: FootnotePropertiesMount;
};

export function DocxEditorDialogs({
  findReplace,
  tableProperties,
  imagePosition,
  imageProperties,
  pageSetup,
  footnoteProperties,
}: DocxEditorDialogsProps) {
  return (
    <Suspense fallback={null}>
      {findReplace.state.dialog.status === "open" && (
        <FindReplaceDialog
          isOpen={true}
          onClose={findReplace.onClose}
          onFind={findReplace.onFind}
          onFindNext={findReplace.onFindNext}
          onFindPrevious={findReplace.onFindPrevious}
          onReplace={findReplace.onReplace}
          onReplaceAll={findReplace.onReplaceAll}
          initialSearchText={findReplace.state.searchText}
          currentResult={findReplace.currentResult}
        />
      )}
      {tableProperties.isOpen && (
        <TablePropertiesDialog
          isOpen={tableProperties.isOpen}
          onClose={tableProperties.onClose}
          onApply={tableProperties.onApply}
          {...(tableProperties.currentProps
            ? { currentProps: tableProperties.currentProps }
            : {})}
        />
      )}
      {imagePosition.isOpen && (
        <ImagePositionDialog
          isOpen={imagePosition.isOpen}
          onClose={imagePosition.onClose}
          onApply={imagePosition.onApply}
        />
      )}
      {imageProperties.isOpen && (
        <ImagePropertiesDialog
          isOpen={imageProperties.isOpen}
          onClose={imageProperties.onClose}
          onApply={imageProperties.onApply}
          {...(imageProperties.currentData
            ? { currentData: imageProperties.currentData }
            : {})}
        />
      )}
      {pageSetup.isOpen && (
        <PageSetupDialog
          isOpen={pageSetup.isOpen}
          onClose={pageSetup.onClose}
          onApply={pageSetup.onApply}
          {...(pageSetup.currentProps
            ? { currentProps: pageSetup.currentProps }
            : {})}
        />
      )}
      {footnoteProperties.isOpen && (
        <FootnotePropertiesDialog
          isOpen={footnoteProperties.isOpen}
          onClose={footnoteProperties.onClose}
          onApply={footnoteProperties.onApply}
          {...(footnoteProperties.footnotePr
            ? { footnotePr: footnoteProperties.footnotePr }
            : {})}
          {...(footnoteProperties.endnotePr
            ? { endnotePr: footnoteProperties.endnotePr }
            : {})}
        />
      )}
    </Suspense>
  );
}
