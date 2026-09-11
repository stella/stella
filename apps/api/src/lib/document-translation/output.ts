import { panic } from "better-result";

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

type BuildBilingualFileNameOptions =
  | {
      type: "automatic-source";
      sourceFileName: string;
      targetLang: string;
    }
  | {
      type: "explicit-source";
      sourceFileName: string;
      sourceLang: string;
      targetLang: string;
    };

/** Name the target; include the source only when the user supplied it. */
export const buildBilingualFileName = (
  options: BuildBilingualFileNameOptions,
): string => {
  const { sourceFileName, targetLang } = options;
  let tag: string;
  switch (options.type) {
    case "automatic-source":
      tag = ` (Bilingual ${targetLang.toUpperCase()})`;
      break;
    case "explicit-source":
      tag =
        ` (${options.sourceLang.toUpperCase()}-` +
        `${targetLang.toUpperCase()})`;
      break;
    default: {
      options satisfies never;
      return panic("Unhandled bilingual filename source");
    }
  }
  const lastDot = sourceFileName.lastIndexOf(".");
  const stem =
    lastDot === -1 ? sourceFileName : sourceFileName.slice(0, lastDot);
  return `${stem}${tag}${DOCX_EXTENSION}`;
};
