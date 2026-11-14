#!/usr/bin/env bun
/**
 * A translation brief for one locale: the messages that need translating there
 * and what a translator needs to get each one right. By default it lists what
 * i18n-check fails on for the locale: English that changed since its
 * translations were accepted, and values still identical to English.
 *
 * Usage: i18n-brief <langs-dir> --locale=<code> [--key=<key> ...]
 *                   [--glossary=<path>] [--usage-in=<dir> ...]
 *
 * --key=<key>        Brief these keys instead (repeatable).
 * --glossary=<path>  Glossary to cite; defaults to glossary.json beside the
 *                    langs dir.
 * --usage-in=<dir>   Show the source lines that use each key (repeatable).
 */
import { panic } from "better-result";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { parseGlossary } from "./glossary-gen";
import type { Glossary, Term } from "./glossary-gen";
import {
  findSourceChanges,
  findUntranslated,
  flattenMessages,
  parseNestedMessages,
  readCheckBaseline,
  readSourceLock,
  readUsageSources,
} from "./i18n-check";
import type { CheckBaseline, NestedMessages, SourceLock } from "./i18n-check";
import {
  findArgumentNames,
  findMentionedTerms,
  findMissingPluralCategories,
} from "./i18n-lint";
import { findKeyUsages } from "./i18n-usage";
import type { KeyUsage, SourceFile } from "./i18n-usage";

type SelectBriefKeysOptions = {
  source: NestedMessages;
  target: NestedMessages;
  locale: string;
  baseline: CheckBaseline;
  lock: SourceLock;
};

/** What i18n-check fails on for the locale, in catalog order. */
export const selectBriefKeys = ({
  source,
  target,
  locale,
  baseline,
  lock,
}: SelectBriefKeysOptions): string[] => {
  const selected = new Set([
    ...findSourceChanges(source, lock).map(({ key }) => key),
    ...findUntranslated(source, target, locale, baseline),
  ]);
  return [...flattenMessages(source).keys()].filter((key) => selected.has(key));
};

type BriefItem = {
  key: string;
  source: string;
  /** The English the current translation was written for, when it has changed since. */
  lockedSource: string | null;
  /** The current translation; null while it still holds the English. */
  translation: string | null;
  placeholders: string[];
  missingPluralCategories: string[];
  terms: Term[];
  usages: KeyUsage[];
};

type BuildBriefItemsOptions = {
  keys: readonly string[];
  source: NestedMessages;
  target: NestedMessages;
  locale: string;
  lock: SourceLock;
  glossary: Glossary;
  files: readonly SourceFile[];
};

export const buildBriefItems = ({
  keys,
  source,
  target,
  locale,
  lock,
  glossary,
  files,
}: BuildBriefItemsOptions): BriefItem[] => {
  const sourceMessages = flattenMessages(source);
  const targetMessages = flattenMessages(target);
  const usages = findKeyUsages({ keys, files });
  return keys.map((key) => {
    const value = sourceMessages.get(key) ?? panic(`${key} is not in en.json`);
    const locked = lock.get(key);
    const translation = targetMessages.get(key);
    return {
      key,
      source: value,
      lockedSource: locked !== undefined && locked !== value ? locked : null,
      translation:
        translation === undefined || translation === value ? null : translation,
      placeholders: findArgumentNames(value),
      missingPluralCategories: findMissingPluralCategories(value, locale),
      terms: findMentionedTerms({ glossary, source: value, key }),
      usages: usages.get(key) ?? [],
    };
  });
};

const USAGES_SHOWN = 3;
// Relative to this file; the CLI fails when it no longer resolves.
const CONVENTIONS_SKILL = "../../../.agents/skills/conventions-i18n/SKILL.md";

const renderTerm = (term: Term, locale: string): string => {
  const rendering = Object.entries(term.translations).find(
    ([code]) => code === locale,
  )?.[1];
  const forbidden = [
    ...(term.forbidden?.[locale] ?? []),
    ...(term.forbiddenOnKey?.[locale] ?? []),
    ...(term.forbiddenAlways?.[locale] ?? []),
  ];
  const parts = [
    `"${term.en}" → ${rendering === undefined ? "(no canonical rendering)" : `"${rendering}"`}`,
  ];
  if (forbidden.length > 0) {
    parts.push(`never ${forbidden.map((word) => `"${word}"`).join(", ")}`);
  }
  // The first sentence says what the concept is; the rest is rationale for
  // whoever maintains the glossary.
  const gist = term.note?.split(/(?<=[.!?])\s/u).at(0);
  if (gist) {
    parts.push(gist);
  }
  return parts.join("; ");
};

const renderItem = (item: BriefItem, locale: string): string[] => {
  const lines = [
    `### \`${item.key}\``,
    "",
    `- English: ${JSON.stringify(item.source)}`,
  ];
  if (item.lockedSource !== null) {
    lines.push(
      `- The ${locale} translation was written for: ${JSON.stringify(item.lockedSource)}`,
    );
  }
  if (item.translation !== null) {
    lines.push(`- Current ${locale}: ${JSON.stringify(item.translation)}`);
  }
  if (item.placeholders.length > 0) {
    lines.push(
      `- Keep exactly: ${item.placeholders.map((name) => (name.startsWith("<") ? `\`${name}\`` : `\`{${name}}\``)).join(", ")}`,
    );
  }
  if (item.missingPluralCategories.length > 0) {
    lines.push(
      `- Plural forms ${locale} needs beyond the English: ${item.missingPluralCategories.join(", ")}`,
    );
  }
  for (const term of item.terms) {
    lines.push(`- Glossary: ${renderTerm(term, locale)}`);
  }
  for (const usage of item.usages.slice(0, USAGES_SHOWN)) {
    lines.push(`- Used in \`${usage.path}:${usage.line}\`: \`${usage.code}\``);
  }
  if (item.usages.length > USAGES_SHOWN) {
    lines.push(`- Used in ${item.usages.length - USAGES_SHOWN} more places`);
  }
  lines.push("");
  return lines;
};

type RenderBriefOptions = {
  locale: string;
  localeFile: string;
  items: readonly BriefItem[];
  /** The translation conventions and the terminology tables a translator reads first. */
  conventions: readonly string[];
};

/** Plain Markdown, for a person or an agent. */
export const renderBrief = ({
  locale,
  localeFile,
  items,
  conventions,
}: RenderBriefOptions): string => {
  const name = new Intl.DisplayNames(["en"], { type: "language" }).of(locale);
  const target = name === undefined ? locale : `${locale} (${name})`;
  if (items.length === 0) {
    return `# Nothing to translate into ${target}\n`;
  }
  const changed = items
    .filter((item) => item.lockedSource !== null)
    .map((item) => item.key);
  const lines = [
    `# Translate ${items.length} ${items.length === 1 ? "message" : "messages"} from en into ${target}`,
    "",
    `Read first: ${conventions.map((file) => `\`${file}\``).join(", ")}.`,
    "",
    "## Rules",
    "",
    "- Keep every placeholder and tag listed for a message exactly as written; translate the text around them.",
    "- Use the glossary rendering for each listed term, never a form it rules out.",
    "- Write the product name in lowercase in every form and position, sentence starts included: stella, stellu, stelle.",
    "- Where the English changed, rework the current translation to say what the English now says; keep its wording where the change does not reach.",
    "- Write complete, natural sentences for a legal professional, never a word-for-word rendering of the English.",
    "",
    "## Messages",
    "",
    ...items.flatMap((item) => renderItem(item, locale)),
    "## Then",
    "",
    `- Write the translations into \`${localeFile}\` and run \`bun run i18n:check\`.`,
  ];
  if (changed.length > 0) {
    lines.push(
      `- Once every locale translates the new English, record it: \`bun run i18n:accept ${changed.join(" ")}\`.`,
    );
  }
  lines.push("");
  return lines.join("\n");
};

// --- CLI ---

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valuesOf = (flag: string): string[] =>
    args.filter((a) => a.startsWith(flag)).map((a) => a.slice(flag.length));
  const langsDir =
    args.find((a) => !a.startsWith("--")) ??
    panic(
      "Usage: i18n-brief <langs-dir> --locale=<code> [--key=<key> ...] [--glossary=<path>] [--usage-in=<dir> ...]",
    );
  const locale =
    valuesOf("--locale=").at(0) ?? panic("i18n-brief needs --locale=<code>");
  if (locale === "en") {
    panic("en is the source locale; brief a target locale");
  }
  const glossaryPath = path.resolve(
    valuesOf("--glossary=").at(0) ?? path.join(langsDir, "..", "glossary.json"),
  );

  const readMessages = async (file: string): Promise<NestedMessages> =>
    parseNestedMessages(
      await Bun.file(path.resolve(langsDir, file)).text(),
      file,
    );
  const localeFile = path.join(langsDir, `${locale}.json`);
  const source = await readMessages("en.json");
  const target = await readMessages(`${locale}.json`);
  const lock =
    (await readSourceLock(langsDir)) ??
    panic(`${langsDir} has no source lock; run i18n:sync first`);
  const explicitKeys = valuesOf("--key=");
  const keys =
    explicitKeys.length > 0
      ? explicitKeys
      : selectBriefKeys({
          source,
          target,
          locale,
          baseline: await readCheckBaseline(langsDir),
          lock,
        });

  const items = buildBriefItems({
    keys,
    source,
    target,
    locale,
    lock,
    glossary: parseGlossary(await Bun.file(glossaryPath).text()),
    files: await readUsageSources({ dirs: valuesOf("--usage-in="), langsDir }),
  });
  // The terminology tables are generated beside the glossary they render.
  const conventions = await Promise.all(
    [
      path.resolve(import.meta.dir, CONVENTIONS_SKILL),
      path.join(path.dirname(glossaryPath), "TERMINOLOGY.md"),
    ].map(async (file) =>
      (await Bun.file(file).exists())
        ? repoRelativePath(process.cwd(), file)
        : panic(`${file} is missing; the brief points translators at it`),
    ),
  );
  process.stdout.write(renderBrief({ locale, localeFile, items, conventions }));
}
