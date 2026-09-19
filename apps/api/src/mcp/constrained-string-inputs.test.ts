/**
 * Census: a string an agent writes is constrained by the reader for its kind,
 * never by the field's own schema.
 *
 * A field that declares its own string format -- an `enum`, a `pattern`, a
 * `format`, a short `maxLength` -- rejects the value before any lenient reader
 * sees it, and the rejection is a schema error naming a length or a regex, so
 * the caller cannot act on it. `country` broke that way: declared
 * `v.maxLength(3)`, it rejected `Czechia` and `Czech Republic` at the schema,
 * and the model answered from memory instead of from the corpus. The
 * constraint, not the reader, decided what a spelling meant.
 *
 * So the constraint is the thing enumerated. This walks every registered
 * tool's projected input schema -- the wire schema the factory emits, so
 * derived and helper-built schemas are covered alike -- plus the body, query,
 * and params schemas of the public case-law and legislation routes, read off
 * the Elysia route table rather than hand-listed. A string property carrying
 * a format constraint has to be owned:
 *
 * - by the `x-stella-agent-input` marker naming a kind the reader dispatches
 *   on, or
 * - by a standard keyword that is itself that annotation: per
 *   `normalizeAgentInput`, a string `enum` is the `enum` kind and
 *   `format: "date"` is the `date` kind. Ownership is decided by asking the
 *   reader whether it claims the schema, not by restating that rule here, so
 *   the exemption cannot drift from the reader, or
 * - by being a UUID, which has one spelling and nothing to normalize. Those
 *   ids are censused by `uuid-id-inputs.test.ts`.
 *
 * Two constraints the wire schema shows in a reduced form still count: a
 * Valibot `regex` behind a `jsonSchemaProjectionWaiver` reaches the projection
 * as its length bound alone, and a TypeBox pattern reaches it verbatim.
 *
 * The allowlist only shrinks: every entry must still be flagged, so a field
 * cannot stay on it after it moves to a kind.
 */

import { describe, expect, test } from "bun:test";

import {
  AGENT_INPUT_NORMALIZATION_KEY,
  AGENT_INPUT_NORMALIZATION_KIND,
  normalizeAgentInput,
} from "@stll/agent-input";
import { UUID_PATTERN } from "@stll/uuid-codec";

import { isRecord } from "@/api/lib/type-guards";
import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import api from "@/api/server";

/**
 * Still hand-constrained, by dotted path, with why. A `language` or a
 * `country` here is the same defect the `country` kind was added to fix, one
 * field over; a cursor or an upstream identifier is a value the caller echoes
 * rather than composes.
 */
const HAND_CONSTRAINED_STRING_INPUTS: Record<string, string> = {
  // A BCP-47 language tag bounded at 8 characters instead of bound to the
  // locale kind, so `cs_CZ` and `Czech` are rejected before it runs.
  "search_case_law.language":
    "language tag length-bounded, not the locale kind",
  "search_legislation.language":
    "language tag length-bounded, not the locale kind",
  "read_statute.language": "language tag length-bounded, not the locale kind",
  "read_statute_provisions.items[].language":
    "language tag length-bounded, not the locale kind",
  "read_provision_history.language":
    "language tag length-bounded, not the locale kind",
  "POST /v1/legislation/corpus/search.body.language":
    "language tag length-bounded, not the locale kind",
  "GET /v1/law/statutes.query.language":
    "language tag length-bounded, not the locale kind",
  "GET /v1/law/statutes/by-eli.query.language":
    "language tag length-bounded, not the locale kind",
  "GET /v1/case/decisions.query.language":
    "language tag length-bounded, not the locale kind",
  "GET /v1/case/decisions/by-slug/:slug.query.language":
    "language tag length-bounded, not the locale kind",
  "POST /v1/case/decisions/search.body.language":
    "language tag length-bounded, not the locale kind",
  "POST /v1/case/research/columns/suggest-prompt.body.filters.language":
    "language tag length-bounded, not the locale kind",

  // Still `t.String({ maxLength: 3 })`, the constraint that rejected
  // `Czechia`: three characters admit the code and refuse the name, so
  // `readPublicLawCountry` never sees the spelling it could read.
  "POST /v1/legislation/corpus/search.body.jurisdiction":
    "ISO 3166-1 code length-bounded, not bound to the country reader",
  "POST /v1/case/research/columns/suggest-prompt.body.country":
    "ISO 3166-1 code length-bounded, not bound to the country reader",

  // The BOE publishes and filters on YYYYMMDD. The upstream spelling is the
  // constraint, so an ISO 2026-09-17 is rejected rather than re-spelled.
  "search_boe_legislation.date_from":
    "upstream BOE YYYYMMDD filter, not the date kind",
  "search_boe_legislation.date_to":
    "upstream BOE YYYYMMDD filter, not the date kind",
  "GET /v1/legislation/search.query.dateFrom":
    "upstream BOE YYYYMMDD filter, not the date kind",
  "GET /v1/legislation/search.query.dateTo":
    "upstream BOE YYYYMMDD filter, not the date kind",
  "GET /v1/legislation/borme/:date.params.date":
    "addresses an upstream BORME daily edition by its YYYYMMDD path spelling",

  // A BOE consolidated-law id (BOE-A-1889-4763) is minted by the publisher and
  // echoed back from a search result, not composed by the caller.
  "GET /v1/legislation/laws/:lawId.params.lawId":
    "publisher-minted BOE consolidated-law identifier",
  "GET /v1/legislation/laws/:lawId/structure.params.lawId":
    "publisher-minted BOE consolidated-law identifier",
  "GET /v1/legislation/laws/:lawId/blocks/:blockId.params.lawId":
    "publisher-minted BOE consolidated-law identifier",
  "GET /v1/legislation/laws/:lawId/related.params.lawId":
    "publisher-minted BOE consolidated-law identifier",

  // The OpenAI-compatible id vocabulary: a value `search` mints and the caller
  // echoes back, never one a model composes. Its pattern is rendered from the
  // same grammar the reader tests (`compat-ids.ts`), so there is nothing here
  // for a value-kind reader to normalize.
  "fetch.id": "an id `search` minted, echoed back verbatim",

  "GET /v1/legislation/search.query.cursor":
    "an opaque server-issued page token, not a model-authored value",

  // Statute citation grammar rather than a value kind: the request asks for
  // the work an act number names, in the spelling a collection prints.
  "GET /v1/law/statutes.query.number":
    "act number in its `<number>/<year>` citation spelling",
  "GET /v1/law/statutes.query.collection":
    "publisher collection segment of an ELI (`sb`, `ul1`, `zz`)",

  // Shard coordinates our own sitemap index emits and a crawler echoes back;
  // the pattern is the shard address, not a spelling a caller chooses.
  "GET /v1/law/sitemap/statutes/shard.query.country":
    "sitemap shard address emitted by the sitemap index",
  "GET /v1/law/sitemap/statutes/shard.query.bucket":
    "sitemap shard address emitted by the sitemap index",
  "GET /v1/case/sitemap/decisions/shard.query.country":
    "sitemap shard address emitted by the sitemap index",
  "GET /v1/case/sitemap/decisions/shard.query.year":
    "sitemap shard address emitted by the sitemap index",
  "GET /v1/case/sitemap/decisions/shard.query.month":
    "sitemap shard address emitted by the sitemap index",
  "GET /v1/case/sitemap/decisions/shard.query.bucket":
    "sitemap shard address emitted by the sitemap index",
};

/** Route prefixes of the public case-law and legislation surface. */
const PUBLIC_LAW_ROUTE_PREFIXES = [
  "/v1/case/",
  "/v1/law/",
  "/v1/legislation/",
] as const;

/** The request parts whose schema a caller fills in. */
const REQUEST_SCHEMA_PARTS = ["body", "query", "params"] as const;

/**
 * At or below this, a `maxLength` is a format constraint rather than a size
 * limit: it admits a code and rejects the name of the thing the code names.
 */
const SHORT_STRING_MAX_LENGTH = 8;

type StringProperty = { path: string; schema: Record<string, unknown> };

const acceptsString = (schema: Record<string, unknown>): boolean => {
  const type = schema["type"];
  return type === "string" || (Array.isArray(type) && type.includes("string"));
};

/** Every string-accepting property in a schema, at any nesting depth. */
const collectStringProperties = (
  schema: unknown,
  path: string,
  found: StringProperty[],
): void => {
  if (!isRecord(schema)) {
    return;
  }
  if (isRecord(schema["properties"])) {
    for (const [key, property] of Object.entries(schema["properties"])) {
      const propertyPath = `${path}.${key}`;
      if (isRecord(property) && acceptsString(property)) {
        found.push({ path: propertyPath, schema: property });
      }
      collectStringProperties(property, propertyPath, found);
    }
  }
  collectStringProperties(schema["items"], `${path}[]`, found);
  for (const keyword of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      collectStringProperties(branch, path, found);
    }
  }
};

const toolStringProperties = ALL_MCP_TOOL_DEFINITIONS.flatMap((tool) => {
  const found: StringProperty[] = [];
  collectStringProperties(tool.inputSchema, tool.name, found);
  return found;
});

const publicLawRoutes = api.routes.filter((route) =>
  PUBLIC_LAW_ROUTE_PREFIXES.some((prefix) => route.path.startsWith(prefix)),
);

const routeStringProperties = publicLawRoutes.flatMap((route) => {
  const hooks: unknown = route.hooks;
  if (!isRecord(hooks)) {
    return [];
  }
  const found: StringProperty[] = [];
  for (const part of REQUEST_SCHEMA_PARTS) {
    collectStringProperties(
      hooks[part],
      `${route.method} ${route.path}.${part}`,
      found,
    );
  }
  return found;
});

const stringProperties = [...toolStringProperties, ...routeStringProperties];

/** The kind the marker names, when it names one the reader dispatches on. */
const declaredKind = (schema: Record<string, unknown>) => {
  const annotation = schema[AGENT_INPUT_NORMALIZATION_KEY];
  if (!isRecord(annotation)) {
    return undefined;
  }
  const kind = annotation["kind"];
  return Object.values(AGENT_INPUT_NORMALIZATION_KIND).find(
    (candidate) => candidate === kind,
  );
};

/**
 * A spelling no kind admits, used to ask the reader whether it claims a
 * schema at all. A claimed schema rejects it with an ask-for-a-fix; an
 * unclaimed one passes it through untouched.
 */
const UNCLAIMED_SPELLING = "zzq-no-kind-claims-this";

const readerClaims = (schema: Record<string, unknown>): boolean =>
  !normalizeAgentInput({ schema, value: UNCLAIMED_SPELLING }).ok;

/** A UUID has one spelling; `uuid-id-inputs.test.ts` censuses these ids. */
const isServerMintedId = (schema: Record<string, unknown>): boolean =>
  schema["format"] === "uuid" || schema["pattern"] === UUID_PATTERN;

const constrainsSpelling = (schema: Record<string, unknown>): boolean => {
  const maxLength = schema["maxLength"];
  return (
    schema["enum"] !== undefined ||
    schema["pattern"] !== undefined ||
    schema["format"] !== undefined ||
    (typeof maxLength === "number" && maxLength <= SHORT_STRING_MAX_LENGTH)
  );
};

const handConstrained = stringProperties
  .filter(
    ({ schema }) =>
      constrainsSpelling(schema) &&
      declaredKind(schema) === undefined &&
      !readerClaims(schema) &&
      !isServerMintedId(schema),
  )
  .map(({ path }) => path);

describe("a string input is constrained by its kind, not by its field", () => {
  test("no tool or public-law route constrains a spelling itself", () => {
    const unowned = handConstrained.filter(
      (path) => HAND_CONSTRAINED_STRING_INPUTS[path] === undefined,
    );

    expect(
      unowned,
      `These string inputs declare their own format, so a spelling carrying one meaning is rejected at the schema before any reader normalizes it: ${unowned.join(", ")}. Bind each to an agent-input kind, or add it to HAND_CONSTRAINED_STRING_INPUTS with the reason it stays hand-constrained.`,
    ).toEqual([]);
  });

  test("the allowlist carries nothing stale", () => {
    // Both directions: an entry whose field moved to a kind has to leave the
    // list, or the list stops meaning what it says.
    const flagged = new Set(handConstrained);
    const stale = Object.keys(HAND_CONSTRAINED_STRING_INPUTS).filter(
      (path) => !flagged.has(path),
    );

    expect(
      stale,
      `These HAND_CONSTRAINED_STRING_INPUTS entries name inputs that are no longer hand-constrained, or no longer exist: ${stale.join(", ")}. Remove them so the list can only shrink.`,
    ).toEqual([]);
  });

  test("the walk finds the string inputs both surfaces declare", () => {
    // A walk that matched nothing would satisfy every assertion above.
    expect(toolStringProperties.length).toBeGreaterThan(200);
    expect(publicLawRoutes.length).toBeGreaterThan(30);
    expect(routeStringProperties.length).toBeGreaterThan(50);
  });

  test("the reader is asked about a schema, not assumed to claim it", () => {
    // The exemption is only as narrow as the reader's own dispatch: a reader
    // that claimed every string would silently empty this census.
    expect(readerClaims({ type: "string" })).toBe(false);
    expect(readerClaims({ type: "string", maxLength: 3 })).toBe(false);
    expect(readerClaims({ type: "string", enum: ["cites", "cited_by"] })).toBe(
      true,
    );
    expect(readerClaims({ type: "string", format: "date" })).toBe(true);
  });
});
