import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript6";
import * as v from "valibot";

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
  const document = ts.parseJsonText(filename, text);
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
      const expected = inputs.get(node.name.text);
      if (expected && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isStringLiteral(property.name) &&
            property.name.text === "inputs"
          ) {
            edits.push({
              start: property.initializer.getStart(document),
              end: property.initializer.end,
              text: JSON.stringify(expected, null, 2).replaceAll(
                "\n",
                () => `\n${lineIndent(text, property.getStart(document))}`,
              ),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(document);
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
