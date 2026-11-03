import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import * as v from "valibot";

import { parseSource, walk } from "./syntax-tree";

const turboTypecheckInputsSchema = v.object({
  tasks: v.record(
    v.string(),
    v.object({ inputs: v.optional(v.array(v.string())) }),
  ),
});

export const readTurboTypecheckInputs = (filename: string) =>
  v.parse(
    turboTypecheckInputsSchema,
    Bun.JSONC.parse(readFileSync(filename, "utf-8")),
  );

/** The leading whitespace of the line holding `offset`. */
const lineIndent = (text: string, offset: number) => {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/u.exec(text.slice(lineStart, offset))?.[0] ?? "";
};

export const writeTurboTypecheckInputs = (
  filename: string,
  inputs: ReadonlyMap<string, readonly string[]>,
) => {
  const text = readFileSync(filename, "utf-8");
  const document = parseSource(`${filename}.js`, `(${text}\n)`);
  const edits: { start: number; end: number; text: string }[] = [];
  walk(document.program, (node) => {
    if (
      node.type !== "Property" ||
      node.key.type !== "Literal" ||
      typeof node.key.value !== "string"
    ) {
      return;
    }
    const expected = inputs.get(node.key.value);
    if (!expected || node.value.type !== "ObjectExpression") {
      return;
    }
    for (const property of node.value.properties) {
      if (
        property.type === "Property" &&
        property.key.type === "Literal" &&
        property.key.value === "inputs"
      ) {
        edits.push({
          start: property.value.start - 1,
          end: property.value.end - 1,
          text: JSON.stringify(expected, null, 2).replaceAll(
            "\n",
            () => `\n${lineIndent(text, property.start - 1)}`,
          ),
        });
      }
    }
  });
  if (edits.length !== inputs.size) {
    panic("Missing split API Turbo task inputs");
  }
  let updated = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    updated =
      updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  }
  writeFileSync(filename, updated);
};
