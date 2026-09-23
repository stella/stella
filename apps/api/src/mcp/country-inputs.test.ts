import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  AGENT_INPUT_NORMALIZATION_KEY,
  AGENT_INPUT_NORMALIZATION_KIND,
} from "@stll/agent-input";

import { isRecord } from "@/api/lib/type-guards";
import { normalizeObjectInputAtBoundary } from "@/api/mcp/input-normalization";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

/**
 * Every country a tool accepts is read by the one country reader.
 *
 * A country decides which body of law a call searches, and a model spells it
 * the way its training data did: `CZ`, `Česko`, `Česká republika` for the
 * corpus's canonical `CZE`. Each of those carries a single meaning, so each is
 * read -- but only where the property is bound to the `country` agent-input
 * kind. A tool that constrains the spelling itself rejects the name before any
 * reader sees it, which is how a case-law search came to answer `not_found` for
 * a country the corpus holds.
 *
 * This walks the advertised input schema of every registered tool and requires
 * the kind annotation on every property named `country` or `country_code`. The
 * annotation is not decoration: `normalizeObjectInputAtBoundary` dispatches on
 * it, so its presence is what makes the reader run, and `defineValibotMcpTool`
 * panics when it names a property that does not exist. A second reader is
 * worse than one strict schema, because two lenient readers disagree.
 *
 * The spelling is required per property because there are two canonical ones:
 * the corpus keys on alpha-3 and a practice-jurisdiction row holds alpha-2, and
 * a missing declaration would write one into the other's column.
 */
const COUNTRY_PROPERTY_NAMES = ["country", "country_code"] as const;

const isCountryProperty = (key: string): boolean =>
  COUNTRY_PROPERTY_NAMES.some((name) => name === key);

/** Every country-named property in an advertised schema, at any depth. */
const collectCountryProperties = (
  schema: unknown,
  path: string,
  found: { path: string; schema: unknown }[],
): void => {
  if (!isRecord(schema)) {
    return;
  }
  if (isRecord(schema["properties"])) {
    for (const [key, property] of Object.entries(schema["properties"])) {
      const propertyPath = `${path}.${key}`;
      if (isCountryProperty(key)) {
        found.push({ path: propertyPath, schema: property });
      }
      collectCountryProperties(property, propertyPath, found);
    }
  }
  collectCountryProperties(schema["items"], `${path}[]`, found);
  for (const keyword of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      collectCountryProperties(branch, path, found);
    }
  }
};

type CountryProperty = {
  path: string;
  tool: string;
  schema: unknown;
};

const countryProperties: readonly CountryProperty[] =
  DEFAULT_MCP_TOOL_DEFINITIONS.flatMap((tool) => {
    const found: { path: string; schema: unknown }[] = [];
    collectCountryProperties(tool.inputSchema, tool.name, found);
    return found.map(({ path, schema }) => ({ path, tool: tool.name, schema }));
  });

const countryAnnotationOf = (
  schema: unknown,
): Record<string, unknown> | undefined => {
  if (!isRecord(schema)) {
    return undefined;
  }
  const annotation = schema[AGENT_INPUT_NORMALIZATION_KEY];
  return isRecord(annotation) ? annotation : undefined;
};

describe("MCP country inputs are read by the shared reader", () => {
  // A walk that matches nothing would satisfy every assertion below.
  test("the walk finds the country inputs the registry declares", () => {
    expect(countryProperties.length).toBeGreaterThanOrEqual(3);
  });

  test("every country input declares the country kind", () => {
    const unowned = countryProperties
      .filter(
        ({ schema }) =>
          countryAnnotationOf(schema)?.["kind"] !==
          AGENT_INPUT_NORMALIZATION_KIND.country,
      )
      .map(({ path }) => path);
    expect(unowned).toEqual([]);
  });

  test("every country input declares which ISO spelling it stores", () => {
    const undeclared = countryProperties
      .filter(({ schema }) => {
        const country = countryAnnotationOf(schema)?.["country"];
        const spelling = isRecord(country) ? country["spelling"] : undefined;
        return spelling !== "alpha-3" && spelling !== "alpha-2";
      })
      .map(({ path }) => path);
    expect(undeclared).toEqual([]);
  });

  // The ask names a tool to call. Naming one the registry does not serve sends
  // the model to a tool that is not there.
  test("a country ask names the tool it is asked from", () => {
    const misnamed = countryProperties
      .filter(({ schema, tool }) => {
        const country = countryAnnotationOf(schema)?.["country"];
        const named = isRecord(country) ? country["tool"] : undefined;
        return named !== undefined && named !== tool;
      })
      .map(({ path }) => path);
    expect(misnamed).toEqual([]);
  });

  test("the registry declares a country on the tools that search a corpus", () => {
    expect(countryProperties.map(({ path }) => path).toSorted()).toEqual([
      "lookup_case_law.country",
      "search_case_law.country",
      "search_legislation.country",
      "set_practice_jurisdictions.jurisdictions[].country_code",
    ]);
  });

  // The description is the whole contract a model reads before it calls.
  test("every country input advertises that names are read", () => {
    const silent = countryProperties
      .filter(({ schema }) => {
        const description = isRecord(schema)
          ? schema["description"]
          : undefined;
        return (
          typeof description !== "string" ||
          !description.includes("ISO 3166-1") ||
          !description.includes("name")
        );
      })
      .map(({ path }) => path);
    expect(silent).toEqual([]);
  });
});

/**
 * The annotations above say the reader is bound; these say it runs. They drive
 * the same boundary function a tool call goes through, over the same projected
 * schema `tools/list` serializes, so a binding that stops dispatching fails
 * here rather than in production.
 */
const schemaOf = (name: string): unknown => {
  const tool = DEFAULT_MCP_TOOL_DEFINITIONS.find(
    (candidate) => candidate.name === name,
  );
  return tool === undefined ? undefined : tool.inputSchema;
};

const readCountry = (
  tool: string,
  value: Record<string, unknown>,
): Record<string, unknown> | { issues: readonly unknown[]; hint: string } => {
  const normalized = normalizeObjectInputAtBoundary({
    schema: schemaOf(tool),
    value,
  });
  return normalized.ok
    ? normalized.value
    : { issues: normalized.issues, hint: normalized.hint };
};

/** The property paths the tool's own validator rejects a value on. */
const sourceSchemaRejects = (
  name: string,
  value: Record<string, unknown>,
): readonly string[] => {
  const tool = DEFAULT_MCP_TOOL_DEFINITIONS.find(
    (candidate) => candidate.name === name,
  );
  const source =
    tool !== undefined && "inputSchemaSource" in tool
      ? tool.inputSchemaSource
      : undefined;
  if (source === undefined) {
    return [];
  }
  const parsed = v.safeParse(source, value);
  return parsed.success
    ? []
    : parsed.issues.flatMap((issue) =>
        (issue.path ?? []).map((segment) => String(segment.key)),
      );
};

describe("a country input reads the spellings a model writes", () => {
  test.each([
    ["CZE", "CZE"],
    ["cze", "CZE"],
    ["CZ", "CZE"],
    ["  cz  ", "CZE"],
    ["Česko", "CZE"],
    ["Cesko", "CZE"],
    ["Česká republika", "CZE"],
    ["Czechia", "CZE"],
    ["Czech Republic", "CZE"],
    ["Slovensko", "SVK"],
    ["Polska", "POL"],
    ["European Union", "EU"],
  ])("search_case_law reads %j as %s", (spelling, canonical) => {
    expect(
      readCountry("search_case_law", { queries: ["q"], country: spelling }),
    ).toMatchObject({ country: canonical });
  });

  // Alpha-2 is what the row holds, so the same spellings canonicalize the
  // other way on this tool.
  test.each([
    ["CZ", "CZ"],
    ["CZE", "CZ"],
    ["Czechia", "CZ"],
    ["Slovensko", "SK"],
  ])("set_practice_jurisdictions reads %j as %s", (spelling, canonical) => {
    expect(
      readCountry("set_practice_jurisdictions", {
        jurisdictions: [{ country_code: spelling, is_primary: true }],
      }),
    ).toMatchObject({
      jurisdictions: [{ country_code: canonical, is_primary: true }],
    });
  });

  // A country is required, so an omitted one must not acquire a value on the
  // way in: reading it as the corpus's only admitted country would answer a
  // question about one body of law from another.
  test("an omitted country is never given a default", () => {
    const result = readCountry("search_case_law", { queries: ["q"] });
    expect(result).not.toHaveProperty("country");
    expect(
      sourceSchemaRejects("search_case_law", { queries: ["q"] }),
    ).toContain("country");
  });

  // An empty or one-character country now reaches the reader instead of the
  // schema's own length bound, so the answer names the accepted forms.
  test.each(["", " ", "   ", "C"])(
    "a country of %j asks and says what is accepted",
    (blank) => {
      const result = readCountry("search_case_law", {
        queries: ["q"],
        country: blank,
      });
      expect(result).toMatchObject({ issues: [{ path: "country" }] });
      expect(
        "hint" in result && typeof result.hint === "string" ? result.hint : "",
      ).toContain("ISO 3166-1");
    },
  );

  test("a whitespace-only country asks and says it is required", () => {
    expect(
      readCountry("search_case_law", { queries: ["q"], country: "   " }),
    ).toMatchObject({
      issues: [{ path: "country" }],
      hint: expect.stringContaining("is required"),
    });
  });

  test("an unreadable country asks and names where to fix it", () => {
    const result = readCountry("search_case_law", {
      queries: ["q"],
      country: "Atlantis",
    });
    expect(result).toMatchObject({
      issues: [{ path: "country" }],
      hint: expect.stringContaining("search_case_law"),
    });
  });

  // A token that names two countries is never guessed: reading `cs` as either
  // successor state would answer about the wrong body of law.
  test("a country naming two readings asks with both named", () => {
    const result = readCountry("search_case_law", {
      queries: ["q"],
      country: "cs",
    });
    expect(result).toMatchObject({
      issues: [{ path: "country" }],
      hint: expect.stringContaining("SVK"),
    });
  });

  // Recognising a country is not admitting it: the corpus answers that.
  test("a recognised country the corpus lacks still reaches the handler", () => {
    expect(
      readCountry("search_case_law", { queries: ["q"], country: "Germany" }),
    ).toMatchObject({ country: "DEU" });
  });
});
