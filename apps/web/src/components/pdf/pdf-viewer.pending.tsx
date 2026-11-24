import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  LanguagesIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  PrinterIcon,
  SunIcon,
  UnfoldHorizontalIcon,
} from "@stll/ui/icons";
import { Separator } from "@stll/ui/separator";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import type { PDFColorMode } from "@/lib/pdf/pdf-color-mode";
import { PDF_PAGE_INLINE_INSET_PX } from "@/lib/pdf/pdf-fit-width.logic";

/*
 * The PDF viewer's frame and toolbar, apart from their behaviour: the
 * viewer, its toolbar and the document page's loading view draw from the
 * same classes, so the viewer that replaces a loading face lands in its box.
 */

export const PDF_COLOR_MODE_ICONS = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
} as const satisfies Record<PDFColorMode, typeof SunIcon>;

/** The glyph of the PDF colour-mode control for the mode it is in. */
export const PdfColorModeIcon = ({
  colorMode,
}: {
  colorMode: PDFColorMode;
}) => {
  const Icon = PDF_COLOR_MODE_ICONS[colorMode];
  return <Icon className="size-3.5" />;
};

/** The PDF viewer's scroll surface and its column of pages. */
export const PDF_VIEWPORT_CLASS = "document-preview-surface h-full";
export const PDF_VIEWPORT_CONTENT_CLASS = "relative mt-2 space-y-2";

/**
 * A PDF before its pages are measured: the viewer's own surface with one
 * page fitted to its width, as a page placeholder draws while it renders.
 * A page's proportions are the file's; until they are known it is drawn as
 * an A4 sheet, which most filed documents are.
 */
export const PdfLoadingShell = () => (
  <div
    aria-hidden="true"
    className={cn(PDF_VIEWPORT_CLASS, "relative overflow-hidden")}
  >
    <div
      className={PDF_VIEWPORT_CONTENT_CLASS}
      style={{ paddingInline: PDF_PAGE_INLINE_INSET_PX }}
    >
      <div className="relative mx-auto aspect-[210/297] w-full border-transparent">
        <Skeleton className="absolute inset-0 h-full w-full rounded-none" />
      </div>
    </div>
  </div>
);

/** The zoom group's box in the PDF toolbar. */
export const PDF_ZOOM_GROUP_CLASS = "flex items-center rounded-md border p-0.5";

/** The current page field and the page count beside it. */
export const PDF_PAGE_FIELD_ROW_CLASS =
  "ms-1.5 me-2 flex items-center gap-x-1.5 text-sm tabular-nums";
const PDF_PAGE_FIELD_CLASS = "me-1 w-14 *:text-end";

export const PdfPageCount = ({
  formattedCount,
}: {
  formattedCount?: string | undefined;
}) => (
  <span className="min-w-[5ch] whitespace-nowrap">
    {formattedCount ?? <FaceLabelPending className="w-3" />}
  </span>
);

const IconButtonFace = ({ children }: { children: ReactNode }) => (
  <ButtonFace size="icon-xs" variant="ghost">
    {children}
  </ButtonFace>
);

/**
 * The PDF toolbar's controls before the viewer mounts, in the toolbar's
 * grid: the zoom group and page navigation centred, the print and translate
 * actions at the end. The actions that wait on the file's metadata or the
 * member's rights (download, sign, edit pages) sit before them and come in
 * with the page, so nothing drawn here moves.
 */
export const PdfToolbarFace = ({
  colorMode,
  page,
}: {
  /** The colour mode the control shows, or `undefined` where it is absent. */
  colorMode: PDFColorMode | undefined;
  page: number;
}) => (
  <div
    aria-hidden="true"
    className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2"
  >
    <div />
    <div className="flex items-center gap-1">
      <div className={PDF_ZOOM_GROUP_CLASS}>
        <IconButtonFace>
          <MinusIcon className="size-3" />
        </IconButtonFace>
        <IconButtonFace>
          <PlusIcon className="size-3" />
        </IconButtonFace>
        <IconButtonFace>
          <UnfoldHorizontalIcon className="size-3" />
        </IconButtonFace>
        {colorMode !== undefined && (
          <>
            <Separator className="mx-0.5 h-4" orientation="vertical" />
            <IconButtonFace>
              <PdfColorModeIcon colorMode={colorMode} />
            </IconButtonFace>
          </>
        )}
      </div>
      <Separator className="mx-1 h-4" orientation="vertical" />
      <IconButtonFace>
        <ChevronUpIcon className="size-3.5" />
      </IconButtonFace>
      <IconButtonFace>
        <ChevronDownIcon className="size-3.5" />
      </IconButtonFace>
      <div className={PDF_PAGE_FIELD_ROW_CLASS}>
        <InputFace
          className={PDF_PAGE_FIELD_CLASS}
          fieldClassName="justify-end"
          size="sm"
        >
          {page}
        </InputFace>
        <span>/</span>
        <PdfPageCount />
      </div>
    </div>
    <div className="flex justify-self-end">
      <div className="flex items-center">
        <IconButtonFace>
          <PrinterIcon className="size-3.5" />
        </IconButtonFace>
        <IconButtonFace>
          <LanguagesIcon className="size-3.5" />
        </IconButtonFace>
      </div>
    </div>
  </div>
);
