import { DOC_MIME_TYPE, DOCX_MIME_TYPE } from "@/api/mime-types";

const DOCX_EXTENSION = ".docx";

type BuildTranslatedFileNameOptions = {
  extensionOverride?: string | undefined;
  sourceFileName: string;
  targetLang: string;
};

const buildTranslatedFileName = ({
  extensionOverride,
  sourceFileName,
  targetLang,
}: BuildTranslatedFileNameOptions): string => {
  const tag = ` (${targetLang.toUpperCase()})`;
  const lastDot = sourceFileName.lastIndexOf(".");
  if (lastDot === -1) {
    return `${sourceFileName}${tag}${extensionOverride ?? ""}`;
  }
  const extension = extensionOverride ?? sourceFileName.slice(lastDot);
  return `${sourceFileName.slice(0, lastDot)}${tag}${extension}`;
};

type ResolveTranslatedOutputOptions = {
  sourceFileName: string;
  sourceMimeType: string;
  targetLang: string;
};

export const resolveTranslatedOutput = ({
  sourceFileName,
  sourceMimeType,
  targetLang,
}: ResolveTranslatedOutputOptions): { fileName: string; mimeType: string } => {
  if (sourceMimeType === DOC_MIME_TYPE) {
    return {
      fileName: buildTranslatedFileName({
        extensionOverride: DOCX_EXTENSION,
        sourceFileName,
        targetLang,
      }),
      mimeType: DOCX_MIME_TYPE,
    };
  }
  return {
    fileName: buildTranslatedFileName({ sourceFileName, targetLang }),
    mimeType: sourceMimeType,
  };
};

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
