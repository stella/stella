/**
 * What the chat composer accepts.
 *
 * `createChatComposerDocument` parses its input as the composer's own inline
 * Markdown and has no HTML path at all, so a caller that hands it markup gets
 * the tags rendered as words. The brand makes that unrepresentable: a composer
 * input exists only as prose escaped for the grammar, or as Markdown a caller
 * wrote against it.
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
