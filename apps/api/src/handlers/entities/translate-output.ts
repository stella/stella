import { DOC_MIME_TYPE, DOCX_MIME_TYPE } from "@/api/mime-types";

const DOCX_EXTENSION = ".docx";

type BuildTranslatedFileNameOptions = {
  sourceFileName: string;
  targetLang: string;
  extensionOverride?: string | undefined;
};

const buildTranslatedFileName = ({
  sourceFileName,
  targetLang,
  extensionOverride,
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

type TranslatedOutput = {
  fileName: string;
  mimeType: string;
};

export const resolveTranslatedOutput = ({
  sourceFileName,
  sourceMimeType,
  targetLang,
}: ResolveTranslatedOutputOptions): TranslatedOutput => {
  if (sourceMimeType === DOC_MIME_TYPE) {
    return {
      fileName: buildTranslatedFileName({
        sourceFileName,
        targetLang,
        extensionOverride: DOCX_EXTENSION,
      }),
      mimeType: DOCX_MIME_TYPE,
    };
  }

  return {
    fileName: buildTranslatedFileName({ sourceFileName, targetLang }),
    mimeType: sourceMimeType,
  };
};
