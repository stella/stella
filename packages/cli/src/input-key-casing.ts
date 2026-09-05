// Tool inputs are snake_case on the wire while every response is camelCase, so
// the natural scripting loop (list, edit, save through `--input`) hands back
// camelCase keys the schema does not declare. Rewrite a camelCase key onto the
// snake_case property the schema does declare; a key the schema declares as-is,
// or one whose snake form it does not declare, is left for validation to judge.

import { isDeepStrictEqual } from "node:util";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** camelCase -> snake_case (`matterId` -> `matter_id`). */
export const snakeCase = (key: string): string =>
  key
    .replace(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower>_$<upper>")
    .toLowerCase();

export type InputKeyCasingResult =
  | { status: "normalized"; args: Record<string, unknown> }
  | { status: "conflict"; camel: string; snake: string };

export const normalizeInputKeyCasing = ({
  args,
  inputSchema,
}: {
  args: Record<string, unknown>;
  inputSchema: unknown;
}): InputKeyCasingResult => {
  const rawProperties = isRecord(inputSchema)
    ? inputSchema["properties"]
    : undefined;
  const properties = isRecord(rawProperties) ? rawProperties : {};
  const renames = new Map<string, string>();

  for (const key of Object.keys(args)) {
    if (key in properties) {
      continue;
    }
    const snake = snakeCase(key);
    if (snake === key || !(snake in properties)) {
      continue;
    }
    if (snake in args && !isDeepStrictEqual(args[snake], args[key])) {
      return { status: "conflict", camel: key, snake };
    }
    renames.set(key, snake);
  }

  if (renames.size === 0) {
    return { status: "normalized", args };
  }
  return {
    status: "normalized",
    args: Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        renames.get(key) ?? key,
        value,
      ]),
    ),
  };
};
