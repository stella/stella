import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, "..", "config");
const TRIGGER_CONFIG_RE = /^triggers\.(.+)\.json$/;

const phraseOwners = new Map<string, string[]>();

for (const fileName of readdirSync(CONFIG_DIR).sort()) {
  const match = TRIGGER_CONFIG_RE.exec(fileName);
  const language = match?.at(1);
  if (language === undefined) {
    continue;
  }

  const groups: unknown = JSON.parse(
    readFileSync(join(CONFIG_DIR, fileName), "utf-8"),
  );
  if (!Array.isArray(groups)) {
    throw new TypeError(`${fileName} must contain an array`);
  }

  for (const group of groups) {
    if (
      typeof group !== "object" ||
      group === null ||
      !("triggers" in group) ||
      !Array.isArray(group.triggers)
    ) {
      throw new TypeError(`${fileName} contains a group without triggers`);
    }

    for (const phrase of group.triggers) {
      if (typeof phrase !== "string") {
        throw new TypeError(`${fileName} contains a non-string trigger`);
      }
      const owners = phraseOwners.get(phrase) ?? [];
      owners.push(language);
      phraseOwners.set(phrase, owners);
    }
  }
}

test.each([
  ["rodné číslo je", "cs"],
  ["číslo občanského průkazu je", "cs"],
  ["Personalausweisnummer lautet", "de"],
  ["passport number is", "en"],
])("%s belongs only to the %s trigger config", (phrase, language) => {
  expect(phraseOwners.get(phrase)).toEqual([language]);
});
