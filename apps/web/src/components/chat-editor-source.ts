/**
 * What the chat composer accepts.
 *
 * `createChatComposerDocument` parses its input as the composer's own inline
 * Markdown and has no HTML path at all, so a caller that hands it markup gets
 * the tags rendered as words. The brand makes that unrepresentable: a composer
 * input exists only as something one of the three constructors minted.
 *
 * Which one to use follows from where the string came from, and nothing else:
 *
 * - `composerText` — a quote, a title, a value: words that must appear exactly
 *   as written, with no syntax read in them.
 * - `composerMarkdown` — Markdown this codebase composed for this grammar. A
 *   tag in it is a defect in the builder, so it panics.
 * - `composerStoredMarkdown` — Markdown that is data: a stored prompt, a model
 *   answer. It is still read as Markdown, but a tag in it is someone's content
 *   rather than a defect, so it is shown instead of ending the session.
 */

import { panic } from "better-result";
import * as v from "valibot";

const composerSourceSchema = v.pipe(v.string(), v.brand("ComposerSource"));

export type ComposerSource = v.InferOutput<typeof composerSourceSchema>;

/**
 * The characters `createChatComposerDocument` reads as syntax: the two bold
 * tokens and the backslash that escapes them. Its grammar has no headings,
 * lists or block quotes, so `#`, `-` and `>` are ordinary text to it, and a
 * closed code span is copied out verbatim, so a backtick needs no escape (one
 * would survive inside the span and be read). `<` is escaped so that quoted
 * document text cannot trip the HTML guard below.
 */
const COMPOSER_SYNTAX = /[\\*_<]/gu;

// An escaped `<` is text the composer will print, not markup: only an
// unescaped tag is the misuse this guard is for.
const HTML_TAG = /(?<!\\)<\/?[a-z][^>]*>/iu;

/** Prose that must reach the composer exactly as it was written. */
export const composerText = (value: string): ComposerSource =>
  v.parse(composerSourceSchema, value.replaceAll(COMPOSER_SYNTAX, "\\$&"));

/**
 * Markdown written for the composer's grammar. Markup here is programmer
 * misuse: the composer cannot render it, so it would reach the reviewer as
 * literal tags.
 */
export const composerMarkdown = (source: string): ComposerSource => {
  if (HTML_TAG.test(source)) {
    return panic("The chat composer renders Markdown, not HTML.");
  }
  return v.parse(composerSourceSchema, source);
};

// Only an unescaped `<` opens a tag. `>` is ordinary text to this grammar, so
// neutralising the opening bracket is enough to make the whole tag print.
const UNESCAPED_ANGLE = /(?<!\\)</gu;

/**
 * Markdown that arrived as content: a saved prompt, a model's answer. It is
 * read as Markdown like any other source, but an HTML tag in it belongs to
 * whoever wrote it, so it is escaped into the words it already is. Nothing is
 * removed, and the caller is never handed a failure for text it does not own.
 */
export const composerStoredMarkdown = (source: string): ComposerSource =>
  v.parse(composerSourceSchema, source.replaceAll(UNESCAPED_ANGLE, "\\<"));
