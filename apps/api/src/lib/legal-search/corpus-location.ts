import { panic } from "better-result";

/**
 * Where a corpus payload's bytes live.
 *
 * A row's key column (`text_s3_key`, `normalized_s3_key`, `ast_s3_key`)
 * stores either a plain object key or a packed address: a byte range inside
 * a larger immutable pack object (see corpus-pack.ts). Every reader goes
 * through {@link parseCorpusLocation}, so a stored value of either form
 * reads the same way.
 *
 * Textual form of a packed address: `pack:<packKey>@<offset>+<length>`, with
 * offset and length as non-negative decimal safe integers. Anything that does
 * not start with `pack:` is a plain object key.
 */
export type ObjectCorpusLocation = { type: "object"; key: string };

export type PackedCorpusLocation = {
  type: "packed";
  packKey: string;
  offset: number;
  length: number;
};

export type CorpusLocation = ObjectCorpusLocation | PackedCorpusLocation;

const PACKED_LOCATION_PREFIX = "pack:";

// The pack key may itself contain `@` or `+`; the anchored digit groups at
// the end make the last `@<digits>+<digits>` the address suffix regardless.
const PACKED_LOCATION_PATTERN =
  /^pack:(?<packKey>.+)@(?<offset>\d+)\+(?<length>\d+)$/u;

const parseSafeInteger = (digits: string, address: string): number => {
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) {
    return panic(
      `Packed corpus address carries an unrepresentable integer: ${address}`,
    );
  }
  return value;
};

/**
 * Decode a stored key column. A value that announces itself as packed but
 * does not match the grammar is corruption of a stored pointer, not an
 * expected runtime failure, so it panics rather than degrading to an
 * object read of a nonsensical key.
 */
export const parseCorpusLocation = (value: string): CorpusLocation => {
  if (!value.startsWith(PACKED_LOCATION_PREFIX)) {
    return { type: "object", key: value };
  }
  const match = PACKED_LOCATION_PATTERN.exec(value);
  const packKey = match?.groups?.["packKey"];
  const offset = match?.groups?.["offset"];
  const length = match?.groups?.["length"];
  if (packKey === undefined || offset === undefined || length === undefined) {
    return panic(`Malformed packed corpus address: ${value}`);
  }
  return {
    type: "packed",
    packKey,
    offset: parseSafeInteger(offset, value),
    length: parseSafeInteger(length, value),
  };
};

export const formatCorpusLocation = (location: CorpusLocation): string => {
  switch (location.type) {
    case "object":
      return location.key;
    case "packed":
      return `${PACKED_LOCATION_PREFIX}${location.packKey}@${location.offset}+${location.length}`;
    default: {
      location satisfies never;
      return panic(`Unhandled corpus location: ${String(location)}`);
    }
  }
};

export const isPackedLocation = (
  location: CorpusLocation,
): location is PackedCorpusLocation => location.type === "packed";
