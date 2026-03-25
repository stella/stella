/** Result from a site-specific translator. */
export type TranslatorResult = {
  citation?: string;
  jurisdiction?: string;
  sourceType: string;
  snippet?: string;
};

/**
 * A translator extracts structured metadata from a known legal
 * source. Translators are matched by URL pattern and run in
 * the content script context (with DOM access).
 */
export type Translator = {
  /** Human-readable name of the source. */
  name: string;
  /** URL pattern to match against the page URL. */
  pattern: RegExp;
  /** Extract structured metadata from the page DOM. */
  extract: (doc: Document) => TranslatorResult | null;
};
