import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CLASSIFICATION_INPUT_PATHS } from "./inputs";

const fixtureContents = (input: string) =>
  path.extname(input) === ".json" ? "{}\n" : "";

export const writeClassificationFixtureInputs = (root: string) => {
  for (const input of CLASSIFICATION_INPUT_PATHS) {
    const target = path.join(root, input);
    if (path.extname(input) === "") {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, fixtureContents(input));
  }
};
