import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { locateEuProvisionCitations } from "@stll/legal-atlas/eu-provision-citations";
import { PROVISION_CITATION_JURISDICTIONS } from "@stll/legal-atlas/provision-citation-profile";
import { provisionCitationProfileFor } from "@stll/legal-atlas/provision-citation-profiles";
import { resolveProvisionCitation } from "@stll/legal-atlas/provision-citation-resolve";

import { isRecord } from "@/api/lib/type-guards";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

/**
 * The `provision` description is the contract an agent reads, so an example it
 * prints must be a provision a filter can answer. An EU citation parses but
 * has no recorded link, so printing one sends the agent to a filter that only
 * says not_found.
 */
const CITED_ON = "2026-01-01";

const provisionDescription = (): string => {
  const schema = DEFAULT_MCP_TOOL_DEFINITIONS.find(
    ({ name }) => name === "search_case_law",
  )?.inputSchema;
  const properties = isRecord(schema) ? schema["properties"] : undefined;
  const provision = isRecord(properties) ? properties["provision"] : undefined;
  const description = isRecord(provision)
    ? provision["description"]
    : undefined;
  return typeof description === "string"
    ? description
    : panic("search_case_law must describe provision");
};

const printedExamples = (description: string): string[] =>
  [...description.matchAll(/"([^"]+)"/gu)].flatMap(([, example]) =>
    example === undefined ? [] : [example],
  );

describe("the search_case_law provision description", () => {
  const description = provisionDescription();

  test("prints only provisions a filter can answer", () => {
    const profile =
      provisionCitationProfileFor("CZE") ?? panic("CZE must have a profile");
    const examples = printedExamples(description);

    expect(examples.length).toBeGreaterThan(0);
    for (const text of examples) {
      expect({
        text,
        eu: locateEuProvisionCitations(text, { citedOn: CITED_ON }).length,
        status: resolveProvisionCitation({
          text,
          profile,
          citedOn: CITED_ON,
        }).status,
      }).toEqual({ text, eu: 0, status: "resolved" });
    }
  });

  // Fails when EU extraction joins the profiles: this sentence then goes stale.
  test("says EU acts have no links while no EU profile extracts them", () => {
    expect(PROVISION_CITATION_JURISDICTIONS).not.toContain("EU");
    expect(description).toContain("EU acts");
    expect(description).toContain("no recorded links");
    expect(description).toContain("queries");
  });
});
