import {
  PdfSignPlacementControls,
  PdfSignPlacementPage,
  placeDefaultStamp,
} from "@/components/inspector/pdf-sign-placement";
import {
  attachPdfSignViewer,
  usePdfSignPlacementStore,
} from "@/components/inspector/pdf-sign-placement-store";
import { useMountEffect } from "@/hooks/use-effect";
import { usePDFStore, usePDFStoreApi } from "@/lib/pdf/pdf-context";

// The placement surface and controls, bound to the PDF viewer they sit in.
// Kept apart from them so the placement itself renders without a viewer.

/** Whether the viewer shows this file's own pages, which a stamp can land on. */
const useShowsOwnPages = () =>
  usePDFStore((state) => state.document?.pageSource === "document");

const useIsPlacing = (fieldId: string) =>
  usePdfSignPlacementStore((state) => state.session?.fieldId === fieldId);

type PdfSignPlacementLayerProps = {
  pageId: string;
};

/**
 * Over one rendered page while its file's stamp is being placed: drag on the
 * page to draw the stamp, then move or resize it. Renders nothing otherwise,
 * so the viewer's own text selection and marks work as usual.
 */
export const PdfSignPlacementLayer = ({
  pageId,
}: PdfSignPlacementLayerProps) => {
  const fieldId = usePDFStore((state) => state.fieldId);
  const pageInfo = usePDFStore((state) => state.pages.get(pageId));
  const showsOwnPages = useShowsOwnPages();
  const isPlacing = useIsPlacing(fieldId);

  if (!isPlacing || !showsOwnPages || pageInfo === undefined) {
    return null;
  }

  return (
    <PdfSignPlacementPage
      // pdf.js applies the page's rotation and crop box, so its scale-1
      // viewport is the displayed page in points, as the API measures it.
      page={{
        height: pageInfo.originalHeight,
        width: pageInfo.originalWidth,
      }}
      pageIndex={pageInfo.proxy.pageNumber - 1}
    />
  );
};

type PdfSignPlacementBarProps = {
  fieldId: string;
};

/**
 * The placement's controls over the viewer of `fieldId`, while its stamp is
 * being placed. Placement ends once no viewer of the file is left.
 */
export const PdfSignPlacementBar = ({ fieldId }: PdfSignPlacementBarProps) => {
  useMountEffect(() => attachPdfSignViewer(fieldId));
  const isPlacing = useIsPlacing(fieldId);
  const showsOwnPages = useShowsOwnPages();
  const lastPageId = usePDFStore((state) =>
    state.document?.pageSource === "document"
      ? state.pages.keys().toArray().at(-1)
      : undefined,
  );
  const pdfStore = usePDFStoreApi();

  if (!isPlacing) {
    return null;
  }

  const placeOnLastPage = () => {
    const { pages, setScrollTo } = pdfStore.getState();
    const pageInfo =
      lastPageId === undefined ? undefined : pages.get(lastPageId);
    if (lastPageId === undefined || pageInfo === undefined) {
      return;
    }
    placeDefaultStamp({
      page: { height: pageInfo.originalHeight, width: pageInfo.originalWidth },
      pageIndex: pageInfo.proxy.pageNumber - 1,
    });
    setScrollTo({ pageId: lastPageId });
  };

  return (
    <PdfSignPlacementControls
      onPlaceOnLastPage={lastPageId === undefined ? undefined : placeOnLastPage}
      showsOwnPages={showsOwnPages}
    />
  );
};
