/**
 * Record ids on the agent wire.
 *
 * Stella ids are lowercase dashed uuids, but a model copies an id through
 * whatever it last saw it in: an uppercase .NET dump, a `{...}` registry form,
 * a `urn:uuid:` URI, a dashless database column. Each of those names the same
 * 128 bits, so each is read.
 *
 * A model with no id to hand invents one, and it invents the same few: the nil
 * uuid, a run of one digit, or the example from the RFC and the tutorials it
 * trained on. Those name no record anywhere. On a required id the handler's
 * `not_found` answers them; on an optional filter they mean "not filtering",
 * so they are read as no value rather than matched against nothing.
 */

import { isAbsentPlaceholder } from "./absent";
import type { NormalizedOptional } from "./normalized";
import { askForFix, readAsAbsent, readValueAs } from "./normalized";

/** Documentation uuids a model reproduces when it has no real id: RFC 4122
 *  and RFC 9562 examples, and the ones tutorials and SDK docs print. */
export const SENTINEL_UUIDS = [
  "123e4567-e89b-12d3-a456-426614174000",
  "123e4567-e89b-12d3-a456-426655440000",
  "01234567-89ab-cdef-0123-456789abcdef",
  "12345678-1234-1234-1234-123456789012",
  "12345678-1234-5678-1234-567812345678",
  "12345678-90ab-cdef-1234-567890abcdef",
  "00000000-0000-0000-0000-000000000001",
] as const;

const SENTINELS: ReadonlySet<string> = new Set(SENTINEL_UUIDS);

const DASHED_RE =
  /^(?<a>[0-9a-f]{8})-(?<b>[0-9a-f]{4})-(?<c>[0-9a-f]{4})-(?<d>[0-9a-f]{4})-(?<e>[0-9a-f]{12})$/u;
const DASHLESS_RE =
  /^(?<a>[0-9a-f]{8})(?<b>[0-9a-f]{4})(?<c>[0-9a-f]{4})(?<d>[0-9a-f]{4})(?<e>[0-9a-f]{12})$/u;
const URN_PREFIX_RE = /^urn:uuid:/u;
const BRACED_RE = /^\{(?<inner>.*)\}$/u;
/** One hex digit repeated 32 times: the nil uuid, the max uuid, and every
 *  `1111…` a model types to fill a slot. */
const REPEATED_DIGIT_RE = /^(?<digit>[0-9a-f])\k<digit>{31}$/u;

const UUID_EXPECTED = "an id";
const UUID_HINT =
  "Pass an id a previous call returned, or omit the property when not " +
  "filtering by it.";

/** Whether a canonical uuid is one a model writes for "some id" rather than a
 *  record's: nil, max, one repeated digit, or a documentation example. */
export const isSentinelUuid = (canonical: string): boolean =>
  SENTINELS.has(canonical) ||
  REPEATED_DIGIT_RE.test(canonical.replaceAll("-", ""));

/** The lowercase dashed form of a uuid in any of the spellings that name one
 *  value, or null. */
const canonicalUuid = (input: string): string | null => {
  const lowered = input.trim().toLowerCase().replace(URN_PREFIX_RE, "");
  const unbraced = BRACED_RE.exec(lowered)?.groups?.["inner"] ?? lowered;
  const groups = (DASHED_RE.exec(unbraced) ?? DASHLESS_RE.exec(unbraced))
    ?.groups;
  if (groups === undefined) {
    return null;
  }
  return [groups["a"], groups["b"], groups["c"], groups["d"], groups["e"]].join(
    "-",
  );
};

export type UuidOptions = {
  /** What the id names, for `expected`: "a matter id". */
  expected?: string | undefined;
  /** The corrective call, when the caller has a better one than the default. */
  hint?: string | undefined;
};

/** Read an id an agent spelled its own way, as a lowercase dashed uuid. A
 *  placeholder or an invented id is no value. */
export const normalizeUuid = (
  input: unknown,
  options: UuidOptions = {},
): NormalizedOptional<string> => {
  if (isAbsentPlaceholder(input)) {
    return readAsAbsent(input);
  }
  const canonical = typeof input === "string" ? canonicalUuid(input) : null;
  if (canonical === null) {
    return askForFix({
      input,
      expected: options.expected ?? UUID_EXPECTED,
      hint: options.hint ?? UUID_HINT,
    });
  }
  if (isSentinelUuid(canonical)) {
    return readAsAbsent(input, "a placeholder id, not a record");
  }
  return readValueAs(input, canonical);
};
