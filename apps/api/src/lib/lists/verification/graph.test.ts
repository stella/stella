import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import { FACT_SCORING } from "@/api/lib/lists/fact-details";
import { FACT_TIERS } from "@/api/lib/lists/source-kind";
import {
  CLAIM_FACT_RELATIONS,
  CLAIM_STATES,
  SCORED_CLAIM_STATES,
} from "@/api/lib/lists/verification/contract";
import { buildVerificationGraph } from "@/api/lib/lists/verification/graph";
import type {
  GraphClaimInput,
  GraphFactInput,
  GraphInput,
  GraphStatementInput,
} from "@/api/lib/lists/verification/graph";

const uuid = (prefix: number, n: number) =>
  `00000000-0000-4000-8${String(prefix)}00-${String(n).padStart(12, "0")}`;
const factId = (n: number) => toSafeId<"entity">(uuid(1, n));
const documentId = (n: number) => toSafeId<"entity">(uuid(2, n));
const runId = (n: number) => toSafeId<"legalListVerificationRun">(uuid(3, n));
const claimId = (n: number) => toSafeId<"legalListClaim">(uuid(4, n));

const FACTS = 8;
const DOCUMENTS = 4;

/**
 * A page of the graph as the read gathers it: statements, the claims of
 * each (citing any of the facts, some withheld between two records), and
 * the facts, some held, some off the list, each with sources.
 */
const graphInputArbitrary: fc.Arbitrary<GraphInput> = fc
  .record({
    statementCount: fc.integer({ min: 1, max: 3 }),
    facts: fc.array(
      fc.record({
        scoring: fc.constantFrom(...FACT_SCORING),
        tier: fc.constantFrom(...FACT_TIERS),
        listed: fc.boolean(),
        sources: fc.uniqueArray(fc.integer({ min: 0, max: DOCUMENTS - 1 }), {
          maxLength: 3,
        }),
      }),
      { minLength: FACTS, maxLength: FACTS },
    ),
    claims: fc.array(
      fc.record({
        statement: fc.nat(),
        state: fc.constantFrom(...CLAIM_STATES),
        refs: fc.uniqueArray(
          fc.record({
            fact: fc.integer({ min: 0, max: FACTS - 1 }),
            rel: fc.constantFrom(...CLAIM_FACT_RELATIONS),
          }),
          { selector: (ref) => ref.fact, maxLength: 4 },
        ),
        conflict: fc.option(
          fc.record({
            pair: fc.uniqueArray(fc.integer({ min: 0, max: FACTS - 1 }), {
              minLength: 2,
              maxLength: 2,
            }),
            states: fc.tuple(
              fc.constantFrom(...SCORED_CLAIM_STATES),
              fc.constantFrom(...SCORED_CLAIM_STATES),
            ),
            governs: fc.option(fc.integer({ min: 0, max: 1 }), {
              nil: null,
            }),
          }),
          { nil: null },
        ),
      }),
      { maxLength: 12 },
    ),
  })
  .map(({ statementCount, facts, claims }) => {
    const statements: GraphStatementInput[] = Array.from(
      { length: statementCount },
      (_, index) => ({
        runId: runId(index),
        entityId: documentId(10 + index),
        fileFieldId: toSafeId<"field">(uuid(5, index)),
        documentName: `Statement ${String(index)}`,
        finishedAt: null,
        claimCount: 0,
      }),
    );
    const factInputs: GraphFactInput[] = facts.map((fact, index) => ({
      factEntityId: factId(index),
      text: `Fact ${String(index)}`,
      occurredOn: null,
      occurredOnPrecision: null,
      standing: { scoring: fact.scoring, tier: fact.tier },
      listOrdinal: fact.listed ? FACTS - index : null,
      sources: fact.sources.map((n) => ({
        documentId: documentId(n),
        documentName: `Source ${String(n)}`,
        locator: { type: "document" },
      })),
    }));
    const claimInputs: GraphClaimInput[] = claims.map((claim, index) => {
      const conflict = claim.conflict;
      const pair = conflict?.pair.map(factId);
      return {
        id: claimId(index),
        runId: runId(claim.statement % statementCount),
        position: index,
        text: `Claim ${String(index)}`,
        state: claim.state,
        refs: claim.refs.map((ref) => ({
          factEntityId: factId(ref.fact),
          rel: ref.rel,
        })),
        recordConflict:
          conflict === null || pair === undefined
            ? null
            : {
                subject: "The date",
                factEntityIds: [pair[0] ?? factId(0), pair[1] ?? factId(1)],
                values: ["one", "two"],
                governingStates: conflict.states,
              },
        governingFactId:
          conflict === null || conflict.governs === null || pair === undefined
            ? null
            : (pair[conflict.governs] ?? null),
        reviewStatus: null,
        qualifiers: [],
      };
    });
    return { statements, claims: claimInputs, facts: factInputs };
  });

/** Every distinct fact a claim links: its two records and its citations. */
const linkedFacts = (claim: GraphClaimInput) =>
  new Set([
    ...(claim.recordConflict?.factEntityIds ?? []),
    ...claim.refs.map((ref) => ref.factEntityId),
  ]);

/** The same rows in another order, as a database may return them. */
const shuffled = <T>(items: readonly T[], seed: number): T[] =>
  items
    .map((item, index) => ({ item, key: (index * 7919 + seed) % 104_729 }))
    .toSorted((a, b) => a.key - b.key)
    .map(({ item }) => item);

describe("buildVerificationGraph", () => {
  test("every claim links each fact it cites or conflicts on exactly once", () => {
    assertProperty(
      "every claim links each fact it cites or conflicts on exactly once",
      fc.property(graphInputArbitrary, (input) => {
        const graph = buildVerificationGraph(input);
        for (const claim of input.claims) {
          const edges = graph.citations.filter(
            (edge) => edge.claimId === claim.id,
          );
          const facts = edges.map((edge) => edge.factId);
          expect(new Set(facts).size).toBe(facts.length);
          expect(new Set(facts)).toEqual(linkedFacts(claim));
          // A citation outside the conflict keeps its grader's relation.
          for (const ref of claim.refs) {
            if (
              claim.recordConflict?.factEntityIds.includes(ref.factEntityId)
            ) {
              continue;
            }
            expect(edges).toContainEqual({
              type: "cites",
              claimId: claim.id,
              factId: ref.factEntityId,
              rel: ref.rel,
            });
          }
        }
        expect(graph.citations).toHaveLength(
          input.claims.reduce((sum, claim) => sum + linkedFacts(claim).size, 0),
        );
      }),
    );
  });

  test("a record conflict draws both records, never one", () => {
    assertProperty(
      "a record conflict draws both records, never one",
      fc.property(graphInputArbitrary, (input) => {
        const graph = buildVerificationGraph(input);
        for (const claim of input.claims) {
          const conflict = claim.recordConflict;
          const edges = graph.citations.filter(
            (edge) =>
              edge.claimId === claim.id && edge.type === "record-conflict",
          );
          if (conflict === null) {
            expect(edges).toEqual([]);
            continue;
          }
          expect(edges).toHaveLength(2);
          const sides = [
            [conflict.factEntityIds[0], conflict.governingStates[0]],
            [conflict.factEntityIds[1], conflict.governingStates[1]],
          ] as const;
          for (const [factEntityId, stateIfGoverning] of sides) {
            expect(edges).toContainEqual({
              type: "record-conflict",
              claimId: claim.id,
              factId: factEntityId,
              stateIfGoverning,
              governs: claim.governingFactId === factEntityId,
            });
          }
        }
      }),
    );
  });

  test("held facts are flagged and facts off the list are marked", () => {
    assertProperty(
      "held facts are flagged and facts off the list are marked",
      fc.property(graphInputArbitrary, (input) => {
        const graph = buildVerificationGraph(input);
        expect(graph.facts).toHaveLength(input.facts.length);
        for (const fact of input.facts) {
          expect(
            graph.facts.find((node) => node.id === fact.factEntityId),
          ).toMatchObject({
            held: fact.standing.scoring === "held",
            tier: fact.standing.tier,
            listed: fact.listOrdinal !== null,
          });
        }
      }),
    );
  });

  test("every fact source becomes one provenance edge to its document", () => {
    assertProperty(
      "every fact source becomes one provenance edge to its document",
      fc.property(graphInputArbitrary, (input) => {
        const graph = buildVerificationGraph(input);
        const sourceIds = new Set(graph.sources.map((source) => source.id));
        expect(sourceIds.size).toBe(graph.sources.length);
        expect(graph.provenance).toHaveLength(
          input.facts.reduce((sum, fact) => sum + fact.sources.length, 0),
        );
        for (const edge of graph.provenance) {
          expect(sourceIds.has(edge.sourceId)).toBe(true);
        }
      }),
    );
  });

  test("the same rows in any order give the same graph", () => {
    assertProperty(
      "the same rows in any order give the same graph",
      fc.property(graphInputArbitrary, fc.nat(), (input, seed) => {
        const reordered: GraphInput = {
          statements: shuffled(input.statements, seed),
          claims: shuffled(input.claims, seed + 1),
          facts: shuffled(input.facts, seed + 2),
        };
        expect(buildVerificationGraph(reordered)).toEqual(
          buildVerificationGraph(input),
        );
      }),
    );
  });

  test("facts follow the list, and facts off it come after", () => {
    assertProperty(
      "facts follow the list, and facts off it come after",
      fc.property(graphInputArbitrary, (input) => {
        const graph = buildVerificationGraph(input);
        const listed = graph.facts.map((fact) => fact.listed);
        expect(listed).toEqual(
          listed.toSorted((a, b) => Number(b) - Number(a)),
        );
        const ordinals = graph.facts
          .map(
            (node) =>
              input.facts.find((fact) => fact.factEntityId === node.id)
                ?.listOrdinal ?? null,
          )
          .filter((ordinal) => ordinal !== null);
        expect(ordinals).toEqual(ordinals.toSorted((a, b) => a - b));
      }),
    );
  });

  test("a claim of a statement the page does not hold is refused", () => {
    expect(() =>
      buildVerificationGraph({
        statements: [],
        claims: [
          {
            id: claimId(1),
            runId: runId(1),
            position: 0,
            text: "Orphan",
            state: "nocover",
            refs: [],
            recordConflict: null,
            governingFactId: null,
            reviewStatus: null,
            qualifiers: [],
          },
        ],
        facts: [],
      }),
    ).toThrow(/belongs to no statement of the page/u);
  });
});
