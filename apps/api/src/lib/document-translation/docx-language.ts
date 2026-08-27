import * as slimdom from "slimdom";

import {
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES,
  type DocumentTranslationSourceLanguageCode,
} from "@stll/api-contract/document-translation";

import { loadDocxArchive } from "@/api/lib/docx-archive";
import { W_NS } from "@/api/lib/docx/ooxml";

const STYLES_PART = "word/styles.xml";
const SETTINGS_PART = "word/settings.xml";
const DOCUMENT_PART = "word/document.xml";

const sourceLanguageFromOoxmlTag = (
  rawTag: string | null,
): DocumentTranslationSourceLanguageCode | null => {
  const baseTag = rawTag?.trim().replaceAll("_", "-").split("-").at(0);
  if (!baseTag) {
    return null;
  }
  const normalizedBaseTag = baseTag.toLowerCase();
  const language = DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.find(({ code }) => {
    const sourceBaseTag = code.toLowerCase().split("-").at(0);
    return (
      sourceBaseTag === normalizedBaseTag ||
      (code === "NB" && normalizedBaseTag === "no")
    );
  });
  return language?.code ?? null;
};

const languageAttribute = (
  element: slimdom.Element,
): DocumentTranslationSourceLanguageCode | null =>
  sourceLanguageFromOoxmlTag(
    element.getAttributeNS(W_NS, "val") ?? element.getAttribute("w:val"),
  );

const parsePart = (xml: string | null): slimdom.Document | null =>
  xml === null ? null : slimdom.parseXmlDocument(xml);

const languageInside = (
  parent: slimdom.Element | null,
  localName: string,
): DocumentTranslationSourceLanguageCode | null => {
  const element = parent?.getElementsByTagNameNS(W_NS, localName).at(0);
  return element ? languageAttribute(element) : null;
};

const defaultRunLanguage = (
  styles: slimdom.Document | null,
): DocumentTranslationSourceLanguageCode | null => {
  const defaults = styles?.getElementsByTagNameNS(W_NS, "docDefaults").at(0);
  return languageInside(defaults ?? null, "lang");
};

const themeLanguage = (
  settings: slimdom.Document | null,
): DocumentTranslationSourceLanguageCode | null => {
  const element = settings?.getElementsByTagNameNS(W_NS, "themeFontLang").at(0);
  return element ? languageAttribute(element) : null;
};

const dominantExplicitLanguage = (
  document: slimdom.Document | null,
): DocumentTranslationSourceLanguageCode | null => {
  if (!document) {
    return null;
  }
  const counts = new Map<DocumentTranslationSourceLanguageCode, number>();
  for (const element of document.getElementsByTagNameNS(W_NS, "lang")) {
    const language = languageAttribute(element);
    if (language !== null) {
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  let dominant: DocumentTranslationSourceLanguageCode | null = null;
  let dominantCount = 0;
  for (const [language, count] of counts) {
    if (count > dominantCount) {
      dominant = language;
      dominantCount = count;
    }
  }
  return dominant;
};

/**
 * Read Word's authored proofing language. The document-wide run default is
 * authoritative; theme metadata is the next document-level declaration.
 * Direct run formatting is only a fallback because a few quoted or pasted
 * runs commonly carry a different language from the document itself.
 */
export const readDocxDeclaredSourceLanguage = async (
  buffer: ArrayBuffer,
): Promise<DocumentTranslationSourceLanguageCode | null> => {
  const archive = await loadDocxArchive(buffer);
  const [stylesXml, settingsXml, documentXml] = await Promise.all([
    archive.readEntryString(STYLES_PART),
    archive.readEntryString(SETTINGS_PART),
    archive.readEntryString(DOCUMENT_PART),
  ]);
  const styles = parsePart(stylesXml);
  const settings = parsePart(settingsXml);
  const document = parsePart(documentXml);
  return (
    defaultRunLanguage(styles) ??
    themeLanguage(settings) ??
    dominantExplicitLanguage(document)
  );
};
