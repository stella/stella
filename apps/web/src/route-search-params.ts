import { Result } from "better-result";
import * as v from "valibot";

/**
 * How the router reads and writes URL search params.
 *
 * A value is the URL's own text unless it holds JSON the app wrote: a quoted
 * string, a list or an object. The router's default reads `?q=2026` as the
 * number 2026 and `?q=true` as a boolean, so a reader who searched for a
 * year, or a link anyone can type, handed a string schema a value it refused
 * and the page failed. Here a schema always receives text for a scalar, and
 * one that wants a number reads it from that text.
 */

/** The first character of JSON that decodes to a string, a list or an object. */
const JSON_VALUE_START = /^["[{]/u;

const decodeSearchValue = (value: string): unknown =>
  JSON_VALUE_START.test(value)
    ? Result.try((): unknown => JSON.parse(value)).unwrapOr(value)
    : value;

const encodeSearchValue = (value: unknown): string => {
  if (typeof value === "string") {
    // Text that would decode to something else is quoted, so it reads back
    // as the same text.
    return decodeSearchValue(value) === value ? value : JSON.stringify(value);
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
};

export const parseRouteSearch = (
  searchStr: string,
): Record<string, unknown> => {
  const values = new Map<string, unknown>();
  for (const [key, value] of new URLSearchParams(searchStr)) {
    // A repeated key keeps its first value: the app never writes one twice,
    // and a list in its place is not a value any schema reads.
    if (!values.has(key)) {
      values.set(key, decodeSearchValue(value));
    }
  }
  // `fromEntries` defines each key as its own property, so a `__proto__`
  // key is a key like any other.
  return Object.fromEntries(values);
};

export const stringifyRouteSearch = (
  search: Record<string, unknown>,
): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined) {
      params.set(key, encodeSearchValue(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
};

type RouteSearchEntries = Record<string, v.GenericSchema>;

/** Every field a link may leave out; a required one fails to compile. */
type OptionalSearchEntries<TEntries extends RouteSearchEntries> = {
  [K in keyof TEntries]: undefined extends v.InferInput<TEntries[K]>
    ? TEntries[K]
    : never;
};

/**
 * A route's search schema. A URL is whatever anyone typed, crawled or kept
 * from an older build, so a value a field refuses is dropped, as though the
 * link never carried it, and the field reads its default; a key no field
 * names is ignored. Every field is therefore optional: one the route cannot
 * open without is checked in `beforeLoad`, where it can redirect instead of
 * failing the page. `route-search-totality.dom.test.tsx` holds every route
 * to this.
 */
export const routeSearchSchema = <const TEntries extends RouteSearchEntries>(
  entries: TEntries & OptionalSearchEntries<TEntries>,
) => {
  const schema = v.object(entries);
  // `entries` stays readable, so a schema can extend another's fields.
  return Object.assign(
    v.pipe(
      // The input a link may pass, typed for navigation; any value reads.
      v.custom<v.InferInput<typeof schema>>(
        (search) => typeof search === "object" && search !== null,
      ),
      v.transform((search) =>
        v.parse(
          schema,
          Object.fromEntries(
            Object.entries(entries).flatMap(([key, entry]) => {
              const value: unknown = Reflect.get(search, key);
              return value !== undefined && v.is(entry, value)
                ? [[key, value]]
                : [];
            }),
          ),
        ),
      ),
    ),
    { entries },
  );
};
