import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { legalResolveResponseSchema } from "@stll/api-contract/legal-resolve";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";

import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { McpRequestContext } from "./context";
import { hasGrantedScope } from "./gateway/static-tool-visibility";
import { normalizeObjectInputAtBoundary } from "./input-normalization";
import { LEGAL_RESOLVE_TOOL_SET } from "./legal-resolve-tools";
import { serializeToolResult } from "./tool-utils";

const contextWith = (
  testDependencies: NonNullable<McpRequestContext["testDependencies"]>,
) => asTestRaw<McpRequestContext>({ testDependencies });

const identity = {
  kind: "decision",
  decisionId: "00000000-0000-4000-8000-0000000d0041",
  identifier: "ECLI:CZ:NS:2026:1.CDO.1.2026.1",
  country: "CZE",
  caseNumber: "1 Cdo 1/2026",
  ecli: "ECLI:CZ:NS:2026:1.CDO.1.2026.1",
  court: "Nejvyšší soud",
  decisionDate: "2026-01-01",
  readerUrl:
    "https://app.stella.law/case-law/00000000-0000-4000-8000-0000000d0041",
} as const;
const responses = {
  resolved: [
    {
      status: "resolved",
      document: { ...identity, text: { status: "readable", blocks: [] } },
    },
    {
      status: "resolved",
      document: {
        ...identity,
        text: { status: "withheld", reason: "licence" },
      },
    },
    {
      status: "resolved",
      document: { ...identity, text: { status: "unavailable" } },
    },
    {
      status: "resolved",
      document: {
        kind: "provision",
        documentId: "00000000-0000-4000-8000-0000000d0042",
        eli: "https://www.e-sbirka.cz/sb/2012/89",
        country: "CZE",
        title: "Občanský zákoník",
        section: "1729",
        readerUrl:
          "https://app.stella.law/legislation/00000000-0000-4000-8000-0000000d0042",
        inForce: { from: "2014-01-01", to: null },
        versionStatus: "current",
        blocks: [],
      },
    },
  ],
  not_found: [
    { status: "not_found", reason: "unknown_document" },
    { status: "not_found", reason: "unknown_section" },
    { status: "not_found", reason: "no_exact_identity" },
  ],
  ambiguous: [
    {
      status: "ambiguous",
      candidates: [
        {
          decisionId: identity.decisionId,
          identifier: "1 Cdo 1/2026",
          label: "Synthetic court",
          readerUrl: identity.readerUrl,
        },
      ],
    },
  ],
  incomplete_identifier: [
    { status: "incomplete_identifier", missing: ["sheet"] },
  ],
  country_unavailable: [{ status: "country_unavailable" }],
} satisfies Record<LegalResolveResponse["status"], LegalResolveResponse[]>;

describe("legal resolve MCP and HTTP envelopes stay identical", () => {
  for (const definition of LEGAL_RESOLVE_TOOL_SET.definitions) {
    const output = LEGAL_RESOLVE_TOOL_SET.outputs[definition.name];
    test(`${definition.name} publishes the shared API schema and law scope`, () => {
      expect(output.outputSchemaSource).toBe(legalResolveResponseSchema);
      expect(output.projection).toBe("identity");
      expect(definition.scope).toBe("stella:law_read");
    });
    for (const [status, variants] of Object.entries(responses)) {
      for (const [index, response] of variants.entries()) {
        test(`${definition.name} preserves ${status} variant ${index}`, async () => {
          const context = contextWith({
            resolveDecision: async () => response,
            resolveLawCitation: async () => response,
          });
          const args =
            definition.name === "resolve_case_law_decision"
              ? { country: "CZE", identifier: identity.identifier }
              : {
                  country: "CZE",
                  source: { type: "citation", citation: "89/2012 Sb." },
                  section: "1729",
                };
          const result = await LEGAL_RESOLVE_TOOL_SET.handlers[definition.name](
            { args, context },
          );
          const wire = serializeToolResult(result, output, definition.name);
          expect(wire.isError).not.toBe(true);
          expect(wire.structuredContent).toEqual(
            v.parse(legalResolveResponseSchema, response),
          );
          expect(wire.content).toEqual([
            { type: "text", text: JSON.stringify(response) },
          ]);
          if (
            response.status === "resolved" &&
            response.document.kind === "decision" &&
            response.document.text.status === "withheld"
          ) {
            expect(wire.structuredContent).not.toHaveProperty(
              "document.blocks",
            );
            expect(wire.structuredContent).not.toHaveProperty(
              "document.text.blocks",
            );
          }
        });
      }
    }
  }

  test("the boundary normalizes country spelling and preserves the exact sheet", async () => {
    const definition = LEGAL_RESOLVE_TOOL_SET.definitions[0];
    const input = {
      country: "Česko",
      identifier: "č. j. 22 Cdo 1000/2020 – 28",
    };
    const normalized = normalizeObjectInputAtBoundary({
      access: "read",
      schema: definition.inputSchema,
      value: input,
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) {
      return;
    }
    const calls: unknown[] = [];
    await LEGAL_RESOLVE_TOOL_SET.handlers.resolve_case_law_decision({
      args: normalized.value,
      context: contextWith({
        resolveDecision: async (...serviceArgs) => {
          calls.push(serviceArgs);
          return { status: "not_found", reason: "no_exact_identity" };
        },
      }),
    });
    expect(calls).toEqual([["CZE", input.identifier]]);
  });

  test("structured and citation inputs dispatch to the same statute service", async () => {
    const calls: unknown[] = [];
    const context = contextWith({
      resolveLawCitation: async (...input) => {
        calls.push(input);
        return { status: "country_unavailable" };
      },
    });
    for (const source of [
      { type: "citation", citation: "zákon č. 89/2012 Sb." },
      { type: "structured", collection: "sb", year: "2012", number: "89" },
    ]) {
      await LEGAL_RESOLVE_TOOL_SET.handlers.resolve_law_citation({
        args: { country: "CZE", source, section: "1729", as_of: "2020-01-01" },
        context,
      });
    }
    expect(calls).toEqual([
      [
        "CZE",
        {
          citation: "zákon č. 89/2012 Sb.",
          section: "1729",
          asOf: "2020-01-01",
        },
      ],
      [
        "CZE",
        {
          collection: "sb",
          year: "2012",
          number: "89",
          section: "1729",
          asOf: "2020-01-01",
        },
      ],
    ]);
  });

  test("contradictory statute sources and batch decision identities are rejected before reading", async () => {
    const calls: unknown[] = [];
    const context = contextWith({
      resolveDecision: async (...input) => {
        calls.push(input);
        return { status: "country_unavailable" };
      },
      resolveLawCitation: async (...input) => {
        calls.push(input);
        return { status: "country_unavailable" };
      },
    });
    const law = await LEGAL_RESOLVE_TOOL_SET.handlers.resolve_law_citation({
      args: {
        country: "CZE",
        source: {
          type: "citation",
          citation: "89/2012 Sb.",
          collection: "sb",
          year: "2012",
          number: "89",
        },
        section: "1",
      },
      context,
    });
    const decision =
      await LEGAL_RESOLVE_TOOL_SET.handlers.resolve_case_law_decision({
        args: { country: "CZE", identifiers: [identity.identifier] },
        context,
      });
    expect(law.status).toBe("error");
    expect(decision.status).toBe("error");
    expect(calls).toEqual([]);
  });

  test("law scope access follows the shared implication in discovery and dispatch", () => {
    for (const scope of [
      [],
      ["stella:search"],
      ["stella:read"],
      ["stella:law_read"],
    ]) {
      expect(hasGrantedScope(scope, "stella:law_read")).toBe(
        scope.includes("stella:read") || scope.includes("stella:law_read"),
      );
    }
    expect(hasGrantedScope(["stella:law_read"], "stella:read")).toBe(false);
  });
});
