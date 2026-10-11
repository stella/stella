import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import { SK_COURT_REFORM_SOURCE } from "./sk-court-reform-source";
import {
  getSkCourtSuccessionEdges,
  skCourtSuccessionReferences,
} from "./sk-court-succession";

describe("statute-derived court relationships", () => {
  test("every edge is supported by literal court spans and versioned hashes", () => {
    const edges = getSkCourtSuccessionEdges();
    expect(edges.length).toBe(93);
    expect(new Set(edges.map(({ id }) => id)).size).toBe(edges.length);
    for (const edge of edges) {
      expect(edge.effectiveFrom).toBe("2023-06-01");
      expect(edge.from.registry.status).toBe("unresolved");
      expect(edge.to.registry.status).toBe("unresolved");
      for (const endpoint of [edge.from, edge.to]) {
        expect(
          edge.citations.some(({ quote }) =>
            quote.includes(endpoint.statedName),
          ),
        ).toBe(true);
      }
      for (const citation of edge.citations) {
        expect(citation.eli).toBe("eli/sk/zz/2004/371");
        expect(citation.version).toBe(edge.effectiveFrom);
        expect(citation.quote).toBe(
          SK_COURT_REFORM_SOURCE[citation.provision].quote,
        );
        expect(citation.quotedSpanHash).toBe(hashSha256Hex(citation.quote));
        expect(citation.url.endsWith(`#${citation.provision}`)).toBe(true);
      }
    }
  });

  test("renaming is distinct from the named transfer memberships", () => {
    const edges = getSkCourtSuccessionEdges();
    expect(edges.filter(({ kind }) => kind === "renaming")).toHaveLength(5);
    const broad = edges.filter(
      (edge) =>
        edge.kind === "jurisdiction-transfer" && edge.scope.subject === "all",
    );
    expect(broad).toHaveLength(17);
    expect(
      broad.some(
        ({ from, to }) =>
          from.statedName === "Okresného súdu Partizánske" &&
          to.statedName === "Okresný súd Prievidza",
      ),
    ).toBe(true);
    const criminal = edges.filter(
      (edge) =>
        edge.kind === "jurisdiction-transfer" &&
        edge.scope.subject === "criminal",
    );
    expect(criminal.map(({ from }) => from.registryMatchName)).toEqual([
      "Okresný súd Bratislava II",
      "Okresný súd Bratislava III",
      "Okresný súd Bratislava IV",
      "Okresný súd Bratislava V",
    ]);
    expect(
      edges.some(({ from }) => from.registryMatchName === "Špeciálny súd"),
    ).toBe(false);
  });

  test("all Bratislava subject transfers retain assignment exceptions and statutory inclusions", () => {
    const edges = getSkCourtSuccessionEdges();
    const scoped = edges.filter(
      (edge) =>
        edge.kind === "jurisdiction-transfer" && edge.scope.subject !== "all",
    );
    expect(scoped).toHaveLength(16);
    for (const edge of scoped) {
      if (edge.kind !== "jurisdiction-transfer") {
        panic("Expected jurisdiction edge");
      }
      expect(edge.scope.exceptions).toHaveLength(1);
      const exception = edge.scope.exceptions.at(0);
      expect(exception).toMatchObject({
        type: "assigned-before-reform-non-predominant-agenda",
        assignedBefore: "2023-06-01",
        caseAgendaRelation: "non-predominant-for-assigned-judge",
        completion: "original-judge",
        afterQuashing: {
          quashedAfter: "2023-06-01",
          returnTo: "city-court-competent-under-post-reform-rules",
        },
      });
      expect(exception?.citation.quotedSpanHash).toBe(
        hashSha256Hex(exception?.citation.quote ?? ""),
      );
      if (edge.scope.subject === "family") {
        expect(edge.scope.statedScope).toContain(
          "Civilného mimosporového poriadku",
        );
      }
      if (edge.scope.subject === "commercial") {
        expect(edge.scope.statedScope).toContain("§ 23 a § 26 až 29");
        expect(edge.scope.statedScope).toContain(
          "agendy konkurzu, reštrukturalizácie, oddĺženia a obchodného registra",
        );
      }
    }
  });

  test("rights and property transfers retain their own conditions", () => {
    const rights = getSkCourtSuccessionEdges().filter(
      ({ kind }) => kind === "rights-and-assets-succession",
    );
    expect(rights).toHaveLength(55);
    for (const edge of rights) {
      if (edge.kind !== "rights-and-assets-succession") {
        panic("Expected rights edge");
      }
      switch (edge.scope.relations) {
        case "all-rights-and-obligations":
          if (edge.from.registryMatchName === "Okresný súd Bratislava V") {
            expect(
              edge.scope.exceptions.map(({ provision }) => provision),
            ).toEqual(
              expect.arrayContaining([
                "paragraf-18n.odsek-5",
                "paragraf-18n.odsek-6",
                "paragraf-18n.odsek-7",
                "paragraf-18n.odsek-8",
                "paragraf-18n.odsek-9",
                "paragraf-18n.odsek-10",
              ]),
            );
            expect(edge.scope.exceptions).toHaveLength(14);
          }
          break;
        case "judge-state":
          expect(edge.scope.excludedOffices).toBe("city-court-presidents");
          break;
        case "employees-and-state-property":
          expect(edge.scope.propertyAdministeredOn).toBe("2023-05-31");
          expect(edge.scope.itemization).toBe("inter-court-agreement-required");
          break;
        case "lay-judge-state":
          expect(edge.scope.relatedJurisdictionProvision).toBe(
            "paragraf-18n.odsek-2",
          );
          break;
        case "president-office":
          expect(edge.scope.term).toBe("remainder-of-original-term");
          break;
        default: {
          const impossible: never = edge.scope;
          panic(String(impossible));
        }
      }
    }
  });

  test("registry resolution uses exact stated evidence and never fuzzy names", () => {
    const known = {
      registreGuid: "sud_102",
      registryName: "Mestský súd Bratislava I",
      decisionName: "Okresný súd Bratislava I",
    };
    const edges = getSkCourtSuccessionEdges([known]);
    const rename = edges.find(
      (edge) =>
        edge.kind === "renaming" &&
        edge.from.registryMatchName === known.decisionName,
    );
    expect(rename?.from.registry).toEqual({
      status: "resolved",
      registreGuid: known.registreGuid,
      evidence: "same-registry-id-decision-name",
    });
    expect(rename?.to.registry).toEqual({
      status: "resolved",
      registreGuid: known.registreGuid,
      evidence: "exact-registry-name",
    });
    for (const wrong of [
      "Mestsky sud Bratislava I",
      "Mestský súd Bratislava I ",
      "Mestský súd Bratislava II",
    ]) {
      const wrongEdges = getSkCourtSuccessionEdges([
        { registreGuid: "other", registryName: wrong },
      ]);
      const wrongRename = wrongEdges.find(({ id }) => id === rename?.id);
      expect(wrongRename?.to.registry).toEqual({
        status: "unresolved",
        reason: "no-exact-match",
      });
    }
    const conflict = getSkCourtSuccessionEdges([
      known,
      { ...known, registreGuid: "conflicting" },
    ]).find(({ id }) => id === rename?.id);
    expect(conflict?.from.registry).toEqual({
      status: "unresolved",
      reason: "ambiguous-exact-match",
    });
    expect(conflict?.to.registry).toEqual({
      status: "unresolved",
      reason: "ambiguous-exact-match",
    });
    expect(getSkCourtSuccessionEdges([known, known])).toEqual(edges);
  });

  test("decision references point to canonical related edges without duplicating source text", () => {
    const name = "Okresný súd Bratislava V";
    const refs = skCourtSuccessionReferences(name, name);
    const edges = getSkCourtSuccessionEdges();
    expect(refs.edgeIds.length).toBeGreaterThan(0);
    expect(refs.edgeIds).toEqual(
      edges
        .filter(
          ({ from, to }) =>
            from.registryMatchName === name || to.registryMatchName === name,
        )
        .map(({ id }) => id),
    );
    expect(skCourtSuccessionReferences(name, name)).toEqual(refs);
    expect(
      skCourtSuccessionReferences(`${name} `, "Unknown court").edgeIds,
    ).toEqual([]);
  });
});
