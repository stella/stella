import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { DESKTOP_DICTATION_CLEANUP_PLAUSIBILITY } from "@stll/api-contract/desktop-dictation-cleanup";

// The cleanup setting names, in each language, two commands a speaker can
// dictate. Each must be one the cleanup prompt applies and its check sets
// aside, or cleanup would type the command as words.
const LANGS_DIR = path.join(import.meta.dir, "../src/i18n/langs");
const QUOTED = /[“„«"]\s*([^“”»"]+?)\s*[”“»"]/gu;

const commands = new Set(
  Object.values(DESKTOP_DICTATION_CLEANUP_PLAUSIBILITY.formattingCommands)
    .flat()
    .map((command) => command.toLowerCase()),
);

const locales = readdirSync(LANGS_DIR).filter((file) => file.endsWith(".json"));

test.each(locales)(
  "every command the %s cleanup setting names is a formatting command",
  (file) => {
    const catalogue: { dictation: { cleanup: { description: string } } } =
      JSON.parse(readFileSync(path.join(LANGS_DIR, file), "utf-8"));
    const named = [
      ...catalogue.dictation.cleanup.description.matchAll(QUOTED),
    ].map((match) => (match[1] ?? "").toLowerCase());
    // A line break and bold, in the catalogue's own language.
    expect(named).toHaveLength(2);
    for (const command of named) {
      expect(commands).toContain(command);
    }
  },
);
