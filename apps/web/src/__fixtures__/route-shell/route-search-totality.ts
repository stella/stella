import { panic, Result } from "better-result";

/**
 * Whether every route reads any URL anyone can type without failing the page.
 *
 * A search value that a route's `validateSearch` refuses throws before the
 * route renders, so the reader gets the error screen for a link: a year as a
 * number, a filter a newer build no longer knows, a tracking tag a marketing
 * link adds. A route reads what it understands and drops the rest. This walks
 * every registered route with each search key any route declares, and with
 * one no route declares, set to values the router hands over from real URLs.
 */

/** URL text a typed, crawled, stale or tampered link can carry. */
const HOSTILE_SEARCH_VALUES = [
  "",
  "x",
  "2026",
  "-1",
  "0",
  "1.5",
  "true",
  "false",
  "null",
  "x".repeat(10_000),
  '"quoted"',
  '["x"]',
  '{"x":1}',
] as const;

/** A key no route declares, as a marketing or analytics link adds one. */
const UNDECLARED_SEARCH_KEY = "utm_source";

type SearchRoute = {
  id: string;
  options: { validateSearch?: unknown };
};

type StandardValidator = {
  "~standard": {
    validate: (value: unknown) => unknown;
  };
};

const isStandardValidator = (value: unknown): value is StandardValidator =>
  typeof value === "object" && value !== null && "~standard" in value;

/** The keys an object schema declares, read off valibot's `entries`. */
const declaredKeys = (validator: unknown): readonly string[] =>
  typeof validator === "object" &&
  validator !== null &&
  "entries" in validator &&
  typeof validator.entries === "object" &&
  validator.entries !== null
    ? Object.keys(validator.entries)
    : [];

const isSearchValidator = (
  validator: unknown,
): validator is (search: Record<string, unknown>) => unknown =>
  typeof validator === "function";

/** Whether the route reads the search without refusing it, as the router does. */
const accepts = (validator: unknown, search: Record<string, unknown>) => {
  if (isSearchValidator(validator)) {
    return Result.try(() => validator(search)).isOk();
  }
  if (isStandardValidator(validator)) {
    const result = validator["~standard"].validate(search);
    if (result instanceof Promise) {
      panic("A route search schema must validate synchronously.");
    }
    return (
      typeof result === "object" &&
      result !== null &&
      !("issues" in result && result.issues !== undefined)
    );
  }
  return panic("A route search validator is neither a function nor a schema.");
};

const describeValue = (value: string) =>
  value.length > 24 ? `${value.slice(0, 8)}…(${value.length})` : value;

/**
 * Each `route key=value` a route refuses. `baseSearch` is the search a route
 * needs to open at all; a hostile value replaces one key of it at a time.
 * `parseSearch` is the router's own reading of a URL, so a route sees what it
 * sees in the app.
 */
export const routeSearchRefusals = (
  routes: readonly SearchRoute[],
  baseSearch: (routeId: string) => Record<string, string>,
  parseSearch: (searchStr: string) => Record<string, unknown>,
): string[] => {
  const keys = new Set<string>([UNDECLARED_SEARCH_KEY]);
  for (const route of routes) {
    for (const key of declaredKeys(route.options.validateSearch)) {
      keys.add(key);
    }
  }
  const refusals: string[] = [];
  for (const route of routes) {
    const validator = route.options.validateSearch;
    if (validator === undefined) {
      continue;
    }
    const base = baseSearch(route.id);
    for (const key of keys) {
      for (const value of HOSTILE_SEARCH_VALUES) {
        const query = new URLSearchParams({ ...base, [key]: value });
        if (!accepts(validator, parseSearch(query.toString()))) {
          refusals.push(`${route.id} ${key}=${describeValue(value)}`);
        }
      }
    }
  }
  return refusals;
};
