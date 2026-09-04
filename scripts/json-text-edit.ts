// Surgical edits to a JSON document's *text*.
//
// Two repo guards must change a handful of string values inside a JSON file and
// leave every other byte identical: the bun.lock workspace-version synchronizer
// and the root package.json resolution fixer. `JSON.parse` + `JSON.stringify`
// reformats the whole file (and bun.lock is not even strict JSON); a regex
// matches nested lookalikes. Walking the structure to the exact string token,
// then splicing, is the only approach that is both precise and format-preserving.
//
// No third-party imports: the autofix workflow runs consumers of this module
// with `bun --no-install` on a checkout that has no node_modules.

export type JsonStringToken = {
  readonly end: number;
  readonly start: number;
  readonly value: string;
};

export type JsonTextReplacement = {
  readonly end: number;
  readonly start: number;
  readonly value: string;
};

export type DirectPropertyOptions = {
  readonly label: string;
  readonly missingMessage?: string;
  readonly objectStart: number;
  readonly property: string;
  readonly text: string;
};

const skipWhitespace = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && /\s/u.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
};

export const stringTokenAt = (text: string, start: number): JsonStringToken => {
  if (text[start] !== '"') {
    throw new TypeError(`expected JSON string at offset ${start}`);
  }
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === '"') {
      const end = index + 1;
      return {
        end,
        start,
        value: JSON.parse(text.slice(start, end)),
      };
    }
    index += 1;
  }
  throw new TypeError(`unterminated JSON string at offset ${start}`);
};

/**
 * Offset of the value of `property` declared directly on the object starting at
 * `objectStart`. Nested objects are skipped by depth, so a same-named property
 * one level down can never be mistaken for the requested one.
 */
export const directPropertyValue = ({
  label,
  missingMessage,
  objectStart,
  property,
  text,
}: DirectPropertyOptions): number => {
  if (text[objectStart] !== "{") {
    throw new TypeError(`expected object at offset ${objectStart}`);
  }
  let depth = 1;
  let index = objectStart + 1;
  while (index < text.length && depth > 0) {
    const character = text[index];
    if (character === '"') {
      const token = stringTokenAt(text, index);
      if (depth === 1) {
        const colon = skipWhitespace(text, token.end);
        if (text[colon] === ":" && token.value === property) {
          return skipWhitespace(text, colon + 1);
        }
      }
      index = token.end;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
    index += 1;
  }
  throw new TypeError(
    missingMessage ??
      `${label} is missing property ${JSON.stringify(property)}`,
  );
};

export const rootObjectStart = (text: string, label: string): number => {
  const start = skipWhitespace(text, 0);
  if (text[start] !== "{") {
    throw new TypeError(`${label} must contain a root object`);
  }
  return start;
};

/**
 * Splices replacements back to front so earlier offsets stay valid. Overlapping
 * spans are a caller bug and would corrupt the document, so they throw.
 */
export const applyReplacements = (
  text: string,
  replacements: readonly JsonTextReplacement[],
): string => {
  const ordered = [...replacements].sort(
    (left, right) => right.start - left.start,
  );
  let output = text;
  let previousStart = text.length;
  for (const replacement of ordered) {
    if (replacement.end > previousStart) {
      throw new TypeError("overlapping JSON text replacements");
    }
    previousStart = replacement.start;
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
};
