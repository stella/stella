import { describe, expect, test } from "bun:test";

import {
  type CallCaseLawTool,
  sampleCaseLawIdentities,
} from "./mcp-canary-case-law-identity";

const SUPREME = "Nejvyšší soud";
const CONSTITUTIONAL = "Ústavní soud";

const hits = {
  [SUPREME]: {
    caseNumber: "26 Cdo 109/2023",
    court: SUPREME,
    decisionId: "supreme",
    ecli: "ECLI:CZ:NS:2023:26.CDO.109.2023.1",
  },
  [CONSTITUTIONAL]: {
    caseNumber: "Pl.ÚS 32/25",
    court: CONSTITUTIONAL,
    decisionId: "plenary",
    ecli: "ECLI:CZ:US:2025:Pl.US.32.25.1",
  },
} as const;

type Resolver = (identifier: string) => unknown;

const answer = (
  resolve: Resolver,
  name: Parameters<CallCaseLawTool>[0],
  args: Record<string, unknown>,
): unknown => {
  if (name === "resolve_case_law_decision") {
    return resolve(String(args["identifier"]));
  }
  const court = args["court"];
  if (court === undefined) {
    return {
      facets: {
        court: [
          { courts: [{ value: CONSTITUTIONAL }] },
          { courts: [{ value: SUPREME }] },
        ],
      },
      results: [],
    };
  }
  const hit = Object.values(hits).find((entry) => entry.court === court);
  return { facets: null, results: hit ? [hit] : [] };
};

/** A deployment whose search samples `hits` and whose resolver is `resolve`. */
const deployment =
  (resolve: Resolver): CallCaseLawTool =>
  async (name, args) => ({
    type: "ok",
    payload: answer(resolve, name, args),
  });

const resolvedTo = (decisionId: string) => ({
  status: "resolved",
  document: { decisionId },
});

/** The resolver a correct deployment is: every identifier names its decision. */
const exact: Resolver = (identifier) => {
  const hit = Object.values(hits).find(
    ({ caseNumber, ecli }) =>
      caseNumber === identifier ||
      ecli.toUpperCase() === identifier.toUpperCase(),
  );
  return hit ? resolvedTo(hit.decisionId) : { status: "not_found" };
};

const outcomeFor = async (resolve: Resolver, country: string) =>
  (await sampleCaseLawIdentities(deployment(resolve))).find(
    (entry) => entry.country === country,
  )?.outcome;

describe("the case-law identity canary", () => {
  test("passes when every docket and ECLI resolves to the decision search found", async () => {
    expect(await outcomeFor(exact, "CZE")).toEqual({
      status: "passed",
      detail:
        "6 identities across 2 courts resolved to the decision search found",
    });
  });

  test("a docket's file listing the decision among its candidates passes", async () => {
    const outcome = await outcomeFor(
      (identifier) =>
        identifier === hits[SUPREME].caseNumber
          ? {
              status: "ambiguous",
              candidates: [
                { decisionId: "sibling" },
                { decisionId: "supreme" },
              ],
            }
          : exact(identifier),
      "CZE",
    );
    expect(outcome?.status).toBe("passed");
  });

  test("fails on a missing sheet, an upper-case ECLI miss, or a list without the decision", async () => {
    const outcome = await outcomeFor((identifier) => {
      if (identifier === hits[SUPREME].caseNumber) {
        return { status: "incomplete_identifier", missing: ["sheet"] };
      }
      if (identifier === hits[CONSTITUTIONAL].ecli.toUpperCase()) {
        return { status: "not_found", reason: "no_exact_identity" };
      }
      if (identifier === hits[CONSTITUTIONAL].caseNumber) {
        return {
          status: "ambiguous",
          candidates: [{ decisionId: "sibling" }],
        };
      }
      return exact(identifier);
    }, "CZE");
    expect(outcome?.status).toBe("failed");
    expect(outcome?.detail).toContain(
      `${SUPREME}: 26 Cdo 109/2023 -> incomplete_identifier`,
    );
    expect(outcome?.detail).toContain(
      `${CONSTITUTIONAL}: ECLI:CZ:US:2025:PL.US.32.25.1 -> not_found`,
    );
    expect(outcome?.detail).toContain(
      `${CONSTITUTIONAL}: Pl.ÚS 32/25 -> ambiguous without it`,
    );
  });

  test("an ECLI never passes as a candidate list", async () => {
    const outcome = await outcomeFor(
      (identifier) =>
        identifier === hits[SUPREME].ecli
          ? { status: "ambiguous", candidates: [{ decisionId: "supreme" }] }
          : exact(identifier),
      "CZE",
    );
    expect(outcome?.status).toBe("failed");
  });

  test("a court its facet names that yields no decision fails", async () => {
    const empty: CallCaseLawTool = async (name, args) =>
      name === "search_case_law" && args["court"] === SUPREME
        ? { type: "ok", payload: { facets: null, results: [] } }
        : await deployment(exact)(name, args);
    const outcome = (await sampleCaseLawIdentities(empty)).find(
      (entry) => entry.country === "CZE",
    )?.outcome;
    expect(outcome?.status).toBe("failed");
    expect(outcome?.detail).toContain(`${SUPREME}: no decision`);
  });

  test("a court sample from another court fails", async () => {
    const unfiltered: CallCaseLawTool = async (name, args) =>
      name === "search_case_law" && args["court"] === SUPREME
        ? {
            type: "ok",
            payload: { facets: null, results: [hits[CONSTITUTIONAL]] },
          }
        : await deployment(exact)(name, args);
    const outcome = (await sampleCaseLawIdentities(unfiltered)).find(
      (entry) => entry.country === "CZE",
    )?.outcome;
    expect(outcome?.status).toBe("failed");
    expect(outcome?.detail).toContain(`${SUPREME}: sampled ${CONSTITUTIONAL}`);
  });

  test("a court sampled without an ECLI is named as docket only", async () => {
    const withoutEcli: CallCaseLawTool = async (name, args) =>
      name === "search_case_law" && args["court"] === SUPREME
        ? {
            type: "ok",
            payload: {
              facets: null,
              results: [{ ...hits[SUPREME], ecli: null }],
            },
          }
        : await deployment(exact)(name, args);
    expect(
      (await sampleCaseLawIdentities(withoutEcli)).find(
        (entry) => entry.country === "CZE",
      )?.outcome,
    ).toEqual({
      status: "passed",
      detail: `4 identities across 2 courts resolved to the decision search found; docket only (no ECLI sampled): ${SUPREME}`,
    });
  });

  test("a country whose search is closed has nothing to sample", async () => {
    expect((await outcomeFor(exact, "AUT"))?.status).toBe("not_applicable");
  });
});
