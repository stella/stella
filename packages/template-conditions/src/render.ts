/**
 * The writer half of the marker grammar.
 *
 * The scanner in `markers.ts` reads `{{ path | label("Deposit") | required }}`;
 * these render one back. They exist so configuration reaches a document the
 * only way it can (as marker text) through the same vocabulary the scanner
 * accepts, and so a round-trip property can pin the two halves together.
 *
 * What can be written depends on the brace pair. A `{{ }}` marker's quoted
 * argument holds anything (`pattern("^[0-9]{5}$")` is a regex, not a nested
 * marker), because the scanner reads a quoted run whole. A `{% %}` tag has no
 * such run, so a brace inside one would end the tag early. A number is refused
 * in either, because its spelling is not the writer's to choose: `1e21` is what
 * JavaScript prints and not what the scanner reads.
 *
 * Those are reported rather than escaped, because an escape the scanner does
 * not know would come back as different text.
 */

import type {
  FilterArgument,
  FilterCall,
  MarkerForm,
  MarkerLiteral,
  MarkerPrefix,
} from "./markers.js";

/** The number literals the scanner reads: no exponent, no `Infinity`. */
const WRITABLE_NUMBER = /^-?\d+(?:\.\d+)?$/u;

/** What a tag's body cannot carry: it has no quoted-run escape hatch, so a
 *  brace or a tag closer inside one would end the tag early. */
const RESERVED_IN_TAG = /[{}]|%\}/u;

/** Why a value has no spelling the scanner reads back as itself. */
export type UnwritableReason = "tag-delimiter" | "number-spelling";

/** The reason this literal cannot be written in a marker of this form, or
 *  `null` when it can. A boolean always can; a string can in a `{{ }}` marker,
 *  because the writer quotes and escapes it. */
export const unwritableMarkerLiteral = (
  value: MarkerLiteral,
  form: MarkerForm = "output",
): UnwritableReason | null => {
  if (typeof value === "number") {
    return WRITABLE_NUMBER.test(String(value)) ? null : "number-spelling";
  }
  if (typeof value === "string" && form === "statement") {
    return RESERVED_IN_TAG.test(value) ? "tag-delimiter" : null;
  }
  return null;
};

/** One string literal, double-quoted, with backslashes and quotes escaped the
 *  way `scanQuoted` reads them back. */
const renderString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const renderLiteral = (value: MarkerLiteral): string =>
  typeof value === "string" ? renderString(value) : String(value);

const renderArgument = (arg: FilterArgument): string =>
  arg.kind === "positional"
    ? renderLiteral(arg.value)
    : `${arg.name}=${renderLiteral(arg.value)}`;

/** Every value in a chain the grammar has no spelling for, with the filter it
 *  was written on and why, so a caller can refuse a configuration before it
 *  rewrites a document into something the scanner would read differently. A
 *  repeat's chain goes in a tag, so pass `"statement"` for one. */
export const unwritableFilterValues = (
  filters: readonly FilterCall[],
  form: MarkerForm = "output",
): { filter: string; value: MarkerLiteral; reason: UnwritableReason }[] =>
  filters.flatMap(({ args, name }) =>
    args.flatMap((arg) => {
      const reason = unwritableMarkerLiteral(arg.value, form);
      return reason === null
        ? []
        : [{ filter: name, value: arg.value, reason }];
    }),
  );

/**
 * One filter chain as marker text, without the leading pipe: `label("A") |
 * required`. An empty chain renders the empty string, which is what a marker
 * that configures nothing carries.
 */
export const renderFilterChain = (filters: readonly FilterCall[]): string =>
  filters
    .map(({ args, name }) =>
      args.length === 0
        ? name
        : `${name}(${args.map(renderArgument).join(", ")})`,
    )
    .join(" | ");

/** One value marker: `{{ path }}` or `{{ path | filters }}`. */
export const renderValueMarker = (
  path: string,
  filters: readonly FilterCall[],
): string => {
  const chain = renderFilterChain(filters);
  return chain === "" ? `{{ ${path} }}` : `{{ ${path} | ${chain} }}`;
};

/** The docxtpl placement token a prefix is written with; `none` writes none. */
const PREFIX_TOKEN = {
  none: "",
  paragraph: "p",
  row: "tr",
} as const satisfies Record<MarkerPrefix, string>;

export type ForOpenerOptions = {
  alias: string;
  path: string;
  filters: readonly FilterCall[];
  /** The placement the opener already carried, so rewriting its filters does
   *  not move a row-form loop off its table row. */
  prefix: MarkerPrefix;
};

/** One `{% for %}` opener, keeping its placement prefix. */
export const renderForOpener = ({
  alias,
  filters,
  path,
  prefix,
}: ForOpenerOptions): string => {
  const chain = renderFilterChain(filters);
  const head = `{%${PREFIX_TOKEN[prefix]} for ${alias} in ${path}`;
  return chain === "" ? `${head} %}` : `${head} | ${chain} %}`;
};
