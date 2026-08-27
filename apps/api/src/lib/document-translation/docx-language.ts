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
const MIN_DOMINANT_LANGUAGE_SHARE = 0.8;

type LanguageAttribute = "bidi" | "eastAsia" | "val";

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
  attribute: LanguageAttribute,
): DocumentTranslationSourceLanguageCode | null =>
  sourceLanguageFromOoxmlTag(
    element.getAttributeNS(W_NS, attribute) ??
      element.getAttribute(`w:${attribute}`),
  );

const parsePart = (xml: string | null): slimdom.Document | null =>
  xml === null ? null : slimdom.parseXmlDocument(xml);

const languageInside = (
  parent: slimdom.Element | null,
  localName: string,
  attribute: LanguageAttribute,
): DocumentTranslationSourceLanguageCode | null => {
  const element = parent?.getElementsByTagNameNS(W_NS, localName).at(0);
  return element ? languageAttribute(element, attribute) : null;
};

const countMatches = (text: string, pattern: RegExp): number =>
  Array.from(text.matchAll(pattern)).length;

const languageAttributeForText = (text: string): LanguageAttribute => {
  const eastAsianCount = countMatches(
    text,
    /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu,
  );
  const bidirectionalCount = countMatches(
    text,
    /\p{Script=Arabic}|\p{Script=Hebrew}/gu,
  );
  const defaultCount =
    countMatches(text, /\p{Letter}/gu) - eastAsianCount - bidirectionalCount;

  if (eastAsianCount > defaultCount && eastAsianCount > bidirectionalCount) {
    return "eastAsia";
  }
  if (
    bidirectionalCount > defaultCount &&
    bidirectionalCount > eastAsianCount
  ) {
    return "bidi";
  }
  return "val";
};

const documentText = (document: slimdom.Document | null): string =>
  document
    ? document
        .getElementsByTagNameNS(W_NS, "t")
        .map((element) => element.textContent)
        .join(" ")
    : "";

const defaultRunLanguage = (
  styles: slimdom.Document | null,
  attribute: LanguageAttribute,
): DocumentTranslationSourceLanguageCode | null => {
  const defaults = styles?.getElementsByTagNameNS(W_NS, "docDefaults").at(0);
  return languageInside(defaults ?? null, "lang", attribute);
};

const themeLanguage = (
  settings: slimdom.Document | null,
  attribute: LanguageAttribute,
): DocumentTranslationSourceLanguageCode | null => {
  const element = settings?.getElementsByTagNameNS(W_NS, "themeFontLang").at(0);
  return element ? languageAttribute(element, attribute) : null;
};

const dominantExplicitLanguage = (
  document: slimdom.Document | null,
): DocumentTranslationSourceLanguageCode | null => {
  if (!document) {
    return null;
  }
  const counts = new Map<DocumentTranslationSourceLanguageCode, number>();
  let totalLetters = 0;
  for (const run of document.getElementsByTagNameNS(W_NS, "r")) {
    const text = Array.from(run.getElementsByTagNameNS(W_NS, "t"))
      .map((element) => element.textContent)
      .join("");
    const letterCount = countMatches(text, /\p{Letter}/gu);
    if (letterCount === 0) {
      continue;
    }
    const element = run.getElementsByTagNameNS(W_NS, "lang").at(0);
    const language = element
      ? languageAttribute(element, languageAttributeForText(text))
      : null;
    if (language !== null) {
      counts.set(language, (counts.get(language) ?? 0) + letterCount);
      totalLetters += letterCount;
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
  if (
    dominant === null ||
    dominantCount / totalLetters < MIN_DOMINANT_LANGUAGE_SHARE
  ) {
    return null;
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
  const attribute = languageAttributeForText(documentText(document));
  return (
    defaultRunLanguage(styles, attribute) ??
    themeLanguage(settings, attribute) ??
    dominantExplicitLanguage(document)
  );
};
