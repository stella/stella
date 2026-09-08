/**
 * The writer half of the marker grammar.
 *
 * The scanner in `markers.ts` reads `{{ path | label("Deposit") | required }}`;
 * these render one back. They exist so configuration reaches a document the
 * only way it can — as marker text — through the same vocabulary the scanner
 * accepts, and so a round-trip property can pin the two halves together.
 *
 * Not every value can be written: the marker span is delimited by braces and
 * the grammar reserves them, so a string carrying `{` or `}` has no spelling.
 * That is reported rather than escaped, because an escape the scanner does not
 * know would come back as different text.
 */

import type {
  FilterArgument,
  FilterCall,
  MarkerLiteral,
  MarkerPrefix,
} from "./markers.js";

/** Characters a marker's text cannot carry: they end the marker span. */
const RESERVED_IN_MARKER = /[{}]/u;

/** The number literals the scanner reads: no exponent, no `Infinity`. */
const WRITABLE_NUMBER = /^-?\d+(?:\.\d+)?$/u;

/** True when a string can be written inside a marker at all. */
export const isWritableMarkerText = (value: string): boolean =>
  !RESERVED_IN_MARKER.test(value);

/** True when a literal has a spelling the scanner reads back as itself. */
export const isWritableMarkerLiteral = (value: MarkerLiteral): boolean => {
  switch (typeof value) {
    case "string":
      return isWritableMarkerText(value);
    case "number":
      return WRITABLE_NUMBER.test(String(value));
    default:
      return true;
  }
};

/** One string literal, double-quoted, with backslashes and quotes escaped the
 *  way `scanQuoted` reads them back. */
const renderString = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const renderLiteral = (value: MarkerLiteral): string => {
  switch (typeof value) {
    case "string":
      return renderString(value);
    case "number":
      return String(value);
    default:
      return value ? "true" : "false";
  }
};

const renderArgument = (arg: FilterArgument): string =>
  arg.kind === "positional"
    ? renderLiteral(arg.value)
    : `${arg.name}=${renderLiteral(arg.value)}`;

/** Every value in a chain the grammar has no spelling for, with the filter it
 *  was written on, so a caller can refuse a configuration before it rewrites a
 *  document into something the scanner would read differently. */
export const unwritableFilterValues = (
  filters: readonly FilterCall[],
): { filter: string; value: MarkerLiteral }[] =>
  filters.flatMap(({ args, name }) =>
    args.flatMap((arg) =>
      isWritableMarkerLiteral(arg.value)
        ? []
        : [{ filter: name, value: arg.value }],
    ),
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
