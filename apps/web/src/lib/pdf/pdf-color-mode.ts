export const PDF_COLOR_MODES = ["light", "dark", "system"] as const;

export type PDFColorMode = (typeof PDF_COLOR_MODES)[number];

type ResolvePDFInvertColorsOptions = {
  colorMode: PDFColorMode;
  isImageOrigin: boolean;
};

export const resolvePDFInvertColors = ({
  colorMode,
  isImageOrigin,
}: ResolvePDFInvertColorsOptions): boolean | undefined => {
  if (isImageOrigin) {
    return false;
  }
  switch (colorMode) {
    case "light":
      return false;
    case "dark":
      return true;
    case "system":
      return undefined;
    default: {
      const exhaustiveColorMode: never = colorMode;
      return exhaustiveColorMode;
    }
  }
};
