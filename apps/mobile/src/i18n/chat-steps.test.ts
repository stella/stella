import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { CHAT_TOOL_LABELS } from "@stll/api-contract/chat-tool-activity";
import { UI_LOCALES } from "@stll/locales";

import { CATALOGS } from "./catalogs";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

/** The web's catalogue for a locale, read as the web ships it. */
const webCatalog = (locale: string): unknown =>
  JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "apps/web/src/i18n/langs", `${locale}.json`),
      "utf-8",
    ),
  );

const nodeSchema = v.record(v.string(), v.unknown());

/** The message at `keys` in a catalogue, or undefined. */
const at = (catalog: unknown, keys: readonly string[]): unknown => {
  let node = catalog;
  for (const key of keys) {
    const parsed = v.safeParse(nodeSchema, node);
    node = parsed.success ? parsed.output[key] : undefined;
  }
  return node;
};

/** Titles the web keeps outside `chat.tool` (`getChatToolTitleKey`). */
const WEB_TITLE_KEYS: Readonly<Record<string, readonly string[]>> = {
  list_connectable_connectors: ["catalogue", "filter", "mcps"],
  show_visual: ["chat", "generatedView"],
  "skill-edit": ["common", "edit"],
};

// A chat on the phone reads as the same chat on the web: each step under
// the title the web gives it, each run summed up in the web's words.
describe("an answer's steps", () => {
  test.each(UI_LOCALES)("are titled in %s as on the web", (locale) => {
    const web = webCatalog(locale);
    const { chat } = CATALOGS[locale];
    expect(Object.keys(chat.tool).toSorted()).toEqual(
      [...CHAT_TOOL_LABELS].toSorted(),
    );
    for (const [label, title] of Object.entries(chat.tool)) {
      expect({
        label,
        title: at(web, WEB_TITLE_KEYS[label] ?? ["chat", "tool", label]),
      }).toEqual({ label, title });
    }
    expect(at(web, ["chat", "processSummary"])).toEqual(chat.processSummary);
    expect(at(web, ["common", "stepCount"])).toBe(chat.stepCount);
    expect(at(web, ["chat", "reasoning"])).toBe(chat.reasoning);
  });
});
