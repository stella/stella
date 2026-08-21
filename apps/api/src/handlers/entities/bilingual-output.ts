const DOCX_EXTENSION = ".docx";

type BuildBilingualFileNameOptions = {
  sourceFileName: string;
  sourceLang: string;
  targetLang: string;
};

/** `Contract.docx` + cs/en -> `Contract (CS-EN).docx`; output is always DOCX. */
export const buildBilingualFileName = ({
  sourceFileName,
  sourceLang,
  targetLang,
}: BuildBilingualFileNameOptions): string => {
  const tag = ` (${sourceLang.toUpperCase()}-${targetLang.toUpperCase()})`;
  const lastDot = sourceFileName.lastIndexOf(".");
  const stem =
    lastDot === -1 ? sourceFileName : sourceFileName.slice(0, lastDot);
  return `${stem}${tag}${DOCX_EXTENSION}`;
};
