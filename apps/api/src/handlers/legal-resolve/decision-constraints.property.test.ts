import { panic, Result } from "better-result";
import { describe, expect, expectTypeOf, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  directoryCourtAliases,
  storedCourtAliases,
} from "@stll/api-contract/court-citation-aliases";
import { courtCitationGrammarOf } from "@stll/api-contract/court-citation-directory";
import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";
import {
  type LegalResolveResponse,
  legalResolveResponseSchema,
} from "@stll/api-contract/legal-resolve";
import { assertProperty } from "@stll/property-testing";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import type { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import { admitLawRead } from "@/api/handlers/legal-resolve/admission";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import {
  admitResolvedDecision,
  decisionConstraints,
  type DecisionResolveResponse,
} from "@/api/handlers/legal-resolve/decision-constraints";
import { createSafeId } from "@/api/lib/branded-types";
import { CASE_LAW_SURFACE_COUNTRIES } from "@/api/lib/case-law/public-subject";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";

const organizationId =
  parseAuthProviderId<"organization">("organization") ??
  panic("Fixture organization id is invalid");
const admissionResult = admitLawRead({
  organizationId,
  publicLawEnabled: () => true,
});
const admission = Result.isOk(admissionResult)
  ? admissionResult.value
  : panic("Fixture law read was not admitted");

/**
 * Every country with an identity surface, with dockets its grammar reads and
 * the courts a citation there can name: the directory's where the country
 * has one, otherwise court names as decisions are stored under them.
 */
const IDENTITY_COUNTRIES = {
  CZE: {
    dockets: ["65 A 3/2025", "8 C 123/2024", "21 Cdo 1234/2019"],
    stored: [],
  },
  SVK: { dockets: ["1S/1/2020", "5Cdo/123/2019"], stored: [] },
  EU: { dockets: ["C-40/17", "T-123/19"], stored: [] },
  POL: {
    dockets: ["II CSK 123/19", "I OSK 1234/20", "I ACa 123/19"],
    stored: [
      "Sąd Najwyższy",
      "Naczelny Sąd Administracyjny",
      "Trybunał Konstytucyjny",
      "Sąd Apelacyjny w Krakowie",
      "Sąd Okręgowy w Krakowie",
      "Sąd Okręgowy w Warszawie",
      "Sąd Rejonowy dla Krakowa-Śródmieścia w Krakowie",
      "Wojewódzki Sąd Administracyjny w Warszawie",
    ],
  },
  HUN: {
    dockets: ["Pfv.I.20.123/2020", "Kfv.IV.37.123/2021"],
    stored: [
      "Kúria",
      "Alkotmánybíróság",
      "Fővárosi Ítélőtábla",
      "Debreceni Ítélőtábla",
      "Szegedi Törvényszék",
      "Pesti Központi Kerületi Bíróság",
    ],
  },
} as const;

type IdentityCountry = keyof typeof IDENTITY_COUNTRIES;

const IDENTITY_COUNTRY_CODES = Object.keys(IDENTITY_COUNTRIES).filter(
  (country): country is IdentityCountry =>
    Object.hasOwn(IDENTITY_COUNTRIES, country),
);

test("the property covers every country with an identity surface", () => {
  expect(Object.keys(IDENTITY_COUNTRIES).toSorted()).toEqual(
    [...CASE_LAW_SURFACE_COUNTRIES.identity].toSorted(),
  );
});

type FixtureCourt = {
  name: string;
  aliases: readonly string[];
  ecliCode: string | undefined;
};

/**
 * The courts a citation in the country can name: every court of its
 * declared grammar, and, where the grammar reads lower courts from stored
 * names, those names. A country without a declared grammar fails here.
 */
const courtsOf = (country: IdentityCountry): readonly FixtureCourt[] => {
  const grammar =
    courtCitationGrammarOf(country) ??
    panic(`${country} has an identity surface but no court citation grammar`);
  const directory = grammar.courts.map((court) => ({
    name: court.name,
    aliases: directoryCourtAliases(country, court),
    ecliCode: court.ecliCodes[0],
  }));
  const stored = IDENTITY_COUNTRIES[country].stored.map((name) => ({
    name,
    aliases: storedCourtAliases(country, name),
    ecliCode: undefined,
  }));
  return [...directory, ...stored];
};

const ecliJurisdictionOf = (country: IdentityCountry): string | null =>
  courtCitationGrammarOf(country)?.ecliJurisdiction ?? null;

const decisionAt = (
  country: IdentityCountry,
  court: FixtureCourt,
  docket: string,
): DecisionIdentityRow => ({
  id: createSafeId<"caseLawDecision">(),
  caseNumber: docket,
  caseNumberType: "case-number",
  country,
  court: court.name,
  courtAbbreviation: null,
  decisionDate: "2025-01-01",
  decisionType: "judgment",
  ecli:
    court.ecliCode === undefined || ecliJurisdictionOf(country) === null
      ? null
      : `ECLI:${ecliJurisdictionOf(country) ?? ""}:${court.ecliCode}:2025:1`,
  identifiers: [],
  language: "cs",
  languageAlternates: [],
  slug: "/case/example",
});

const readable: typeof readDecisionReaderSource = async () => null;

const citation = (alias: string, docket: string, before: boolean): string =>
  before ? `${alias} ${docket}` : `${docket} ${alias}`;

/** A docket, a court holding it, and another court, in one country. */
const pairArbitrary = fc
  .constantFrom(...IDENTITY_COUNTRY_CODES)
  .chain((country) => {
    const courts = courtsOf(country);
    return fc.record({
      country: fc.constant(country),
      docket: fc.constantFrom(...IDENTITY_COUNTRIES[country].dockets),
      holder: fc.constantFrom(...courts),
      other: fc.constantFrom(...courts),
      before: fc.boolean(),
      aliasIndex: fc.nat(),
    });
  })
  .filter(({ holder, other }) => holder.name !== other.name);

const resolveWith = async (
  country: string,
  identifier: string,
  rows: readonly DecisionIdentityRow[],
): Promise<LegalResolveResponse> =>
  await resolveDecision({
    admission,
    country,
    identifier,
    dependencies: { lookup: async () => [...rows], read: readable },
  });

describe("court constraints hold for every identity country", () => {
  test("legal-resolve.court-constraint-never-resolves-another-court", async () => {
    await assertProperty(
      "legal-resolve.court-constraint-never-resolves-another-court",
      fc.asyncProperty(
        pairArbitrary,
        async ({ country, docket, holder, other, before, aliasIndex }) => {
          const decision = decisionAt(country, holder, docket);
          const alias =
            other.aliases[aliasIndex % other.aliases.length] ??
            panic("A court without aliases");
          const result = await resolveWith(
            country,
            citation(alias, docket, before),
            [decision],
          );
          expect(v.safeParse(legalResolveResponseSchema, result).success).toBe(
            true,
          );
          expect(result.status, `${country} ${alias} ${docket}`).not.toBe(
            "resolved",
          );
          // The decision is still offered, as a decision at another court.
          expect(result).toMatchObject({
            status: "not_found",
            otherCourtCandidates: [{ decisionId: decision.id }],
          });
        },
      ),
    );
  });

  test("legal-resolve.court-constraint-resolves-its-own-court", async () => {
    await assertProperty(
      "legal-resolve.court-constraint-resolves-its-own-court",
      fc.asyncProperty(
        pairArbitrary,
        async ({ country, docket, holder, other, before, aliasIndex }) => {
          const decision = decisionAt(country, holder, docket);
          const elsewhere = decisionAt(country, other, docket);
          const alias =
            holder.aliases[aliasIndex % holder.aliases.length] ??
            panic("A court without aliases");
          const result = await resolveWith(
            country,
            citation(alias, docket, before),
            [decision, elsewhere],
          );
          expect(result, `${country} ${alias} ${docket}`).toMatchObject({
            status: "resolved",
            document: { decisionId: decision.id, court: holder.name },
            otherCourtCandidates: [{ decisionId: elsewhere.id }],
          });
        },
      ),
    );
  });

  test("every court of every identity country resolves from each of its aliases and codes", async () => {
    for (const country of IDENTITY_COUNTRY_CODES) {
      const [docket] = IDENTITY_COUNTRIES[country].dockets;
      for (const court of courtsOf(country)) {
        const decision = decisionAt(country, court, docket);
        const codes =
          court.ecliCode === undefined || court.ecliCode.length < 2
            ? []
            : [court.ecliCode];
        for (const alias of [...court.aliases, ...codes]) {
          for (const before of [true, false]) {
            const result = await resolveWith(
              country,
              citation(alias, docket, before),
              [decision],
            );
            expect(
              result,
              `${country} ${citation(alias, docket, before)}`,
            ).toMatchObject({
              status: "resolved",
              document: { decisionId: decision.id },
            });
          }
        }
      }
    }
  });

  test("an alias two courts answer to never resolves either court's decision", async () => {
    const decision = decisionAt(
      "CZE",
      { name: "Okresní soud Neznámov", aliases: [], ecliCode: undefined },
      "65 A 3/2025",
    );
    const sibling = {
      ...decisionAt(
        "CZE",
        { name: "Obvodní soud Neznámov", aliases: [], ecliCode: undefined },
        "65 A 3/2025",
      ),
    };
    const result = await resolveWith("CZE", "OS Neznámov 65 A 3/2025", [
      decision,
      sibling,
    ]);
    expect(result.status).toBe("ambiguous");
    const lone = await resolveWith("CZE", "OS Neznámov 65 A 3/2025", [
      decision,
      { ...sibling, caseNumber: "66 A 3/2025" },
    ]);
    expect(lone).toMatchObject({
      status: "ambiguous",
      candidates: [{ decisionId: decision.id }],
    });
  });

  test("the constructor never resolves under a court alias two courts share", async () => {
    for (const country of IDENTITY_COUNTRY_CODES) {
      const [docket] = IDENTITY_COUNTRIES[country].dockets;
      const [court] = courtsOf(country);
      if (court === undefined) {
        panic(`${country} has no courts`);
      }
      const decision = decisionAt(country, court, docket);
      const intent = parseDecisionQuery(docket, {
        grammar: decisionDocketGrammarForCountry(country),
      });
      if (intent.type !== "identifier") {
        panic(`${country} fixture docket is not read`);
      }
      const constraints = decisionConstraints({
        country,
        intent,
        reporters: null,
        courtText: "",
        holders: [decision],
      });
      const key = `${country}:${court.name}`;
      const result = await admitResolvedDecision({
        constraints: {
          ...constraints,
          courts: [{ type: "court", courts: [key, `${key} (twin)`] }],
        },
        row: decision,
        document: async () => panic("An ambiguous court must not fetch text"),
        candidate: (row) => ({
          decisionId: row.id,
          identifier: row.caseNumber,
          label: row.court,
          readerUrl: "/case/example",
        }),
        otherCourtCandidate: (row) => ({
          decisionId: row.id,
          identifier: row.caseNumber,
          label: row.court,
          readerUrl: "/case/example",
          court: row.court,
          decisionDate: row.decisionDate,
          decisionType: row.decisionType,
          subjectSummary: null,
        }),
        otherCourtCandidates: [],
      });
      expect(result, country).toMatchObject({
        status: "ambiguous",
        candidates: [{ decisionId: decision.id }],
      });
    }
  });

  test("a resolved answer is only made by the constraint check", () => {
    type ResolvedLiteral = Extract<
      LegalResolveResponse,
      { status: "resolved" }
    >;
    expectTypeOf<ResolvedLiteral>().not.toExtend<DecisionResolveResponse>();
    expectTypeOf<
      Exclude<LegalResolveResponse, { status: "resolved" }>
    >().toExtend<DecisionResolveResponse>();
  });
});
