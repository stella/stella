import { panic } from "better-result";
import { parseSync } from "oxc-parser";

import type { ReplayWriterOwner } from "../case-law-replay-writer-registry.ts";
import {
  getPropertyName,
  isAstNode,
  staticStringValue,
  unwrapExpression,
} from "../utils.ts";
import type { AstNode } from "../utils.ts";

const fieldsOf = (value: unknown) => {
  const object = unwrapExpression(value);
  if (
    object?.type !== "ObjectExpression" ||
    !Array.isArray(object.properties)
  ) {
    return panic("Replay registry must contain literal records");
  }
  const fields: Record<string, AstNode> = {};
  for (const property of object.properties) {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      property.computed
    ) {
      return panic("Replay registry fields must be static");
    }
    const key = getPropertyName(property.key);
    if (
      key === null ||
      !isAstNode(property.value) ||
      Object.hasOwn(fields, key)
    ) {
      return panic("Replay registry has an invalid or duplicate field");
    }
    fields[key] = property.value;
  }
  return fields;
};

/** Read the merge-base data without evaluating code from another revision. */
export const readReplayWriterRegistry = (
  source: string,
): ReplayWriterOwner[] => {
  const parsed = parseSync("registry.ts", source, { range: true });
  if (parsed.errors.length > 0) {
    return panic("Cannot parse replay registry");
  }
  const declarations = parsed.program.body.flatMap((statement) =>
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration?.type === "VariableDeclaration"
      ? statement.declaration.declarations
      : [],
  );
  const declaration = declarations.find(
    (value) =>
      value.id.type === "Identifier" &&
      value.id.name === "REPLAY_WRITER_REGISTRY",
  );
  const array = unwrapExpression(declaration?.init);
  if (array?.type !== "ArrayExpression" || !Array.isArray(array.elements)) {
    return panic("Replay registry must export a literal array");
  }
  return array.elements.map((element) => {
    const fields = fieldsOf(element);
    const file = staticStringValue(fields.file);
    const location = fields.line;
    const line = location?.type === "Literal" ? location.value : undefined;
    const kind = staticStringValue(fields.kind);
    if (
      file === null ||
      typeof line !== "number" ||
      !Number.isSafeInteger(line) ||
      line < 1
    ) {
      return panic("Replay owner requires a file and line");
    }
    switch (kind) {
      case "pending":
        return { file, line, kind } satisfies ReplayWriterOwner;
      case "transition": {
        const proof = fieldsOf(fields.invariant);
        const testFile = staticStringValue(proof.file);
        const test = staticStringValue(proof.test);
        if (testFile === null || test === null || test.trim().length === 0) {
          return panic("Replay transition requires an executable invariant");
        }
        return {
          file,
          line,
          kind,
          invariant: { file: testFile, test },
        } satisfies ReplayWriterOwner;
      }
      default:
        return panic("Unknown replay owner classification");
    }
  });
};

export const addedPendingOwners = (
  current: readonly ReplayWriterOwner[],
  previous: readonly ReplayWriterOwner[],
) => {
  const prior = new Set(
    previous
      .filter((owner) => owner.kind === "pending")
      .map(({ file, line }) => `${file}:${line}`),
  );
  return current.filter(
    (owner) =>
      owner.kind === "pending" && !prior.has(`${owner.file}:${owner.line}`),
  );
};
