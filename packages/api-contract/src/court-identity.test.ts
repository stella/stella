import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { foldCourtText } from "./court-citation-aliases";
import { courtCitationGrammarOf } from "./court-citation-directory";
import {
  directoryCourtById,
  directoryCourtIdentities,
  PRINTED_COURT_JURISDICTIONS,
  type PrintedCourtJurisdiction,
  readPrintedCourt,
} from "./court-identity";

const idOf = (country: PrintedCourtJurisdiction, printed: string) => {
  const reading = readPrintedCourt(country, printed);
  return reading.type === "court" ? reading.court.id : reading.type;
};

describe("one court, one identity", () => {
  test.each(PRINTED_COURT_JURISDICTIONS)(
    "%s: every directory court is read back from its own official name, and no other court is",
    (country) => {
      const courts = directoryCourtIdentities(country);
      expect(courts.length).toBeGreaterThan(70);
      const misread = courts.filter(
        ({ id, name }) => idOf(country, name) !== id,
      );
      expect(misread).toEqual([]);
      // Two official names a reader cannot tell apart would be one spelling
      // naming two courts: refused for both, so neither could be stored.
      const folded = new Map<string, string>();
      for (const { name } of courts) {
        const key = foldCourtText(name).join(" ");
        expect(folded.get(key)).toBeUndefined();
        folded.set(key, name);
      }
      for (const court of courts) {
        expect(directoryCourtById(country, court.id)).toEqual(court);
      }
    },
  );
});

/**
 * The court names publishers print for one court, as their court fields
 * state them: the official name beside the forms the corpus received for it.
 * Each group is one court, whatever the publisher.
 */
const PRINTED_SPELLINGS: Readonly<
  Record<PrintedCourtJurisdiction, Readonly<Record<string, readonly string[]>>>
> = {
  CZE: {
    KSHKPA: [
      "Krajský soud v Hradci Králové – pobočka v Pardubicích",
      "Krajský soud v Hradci Králové, pobočka Pardubice",
    ],
    KSCBTA: [
      "Krajský soud v Českých Budějovicích – pobočka v Táboře",
      "Krajský soud v Českých Budějovicích, pobočka v Táboře",
    ],
    KSOSOL: [
      "Krajský soud v Ostravě – pobočka v Olomouci",
      "Krajský soud v Ostravě, pobočka Olomouc",
    ],
    KSULLI: [
      "Krajský soud v Ústí nad Labem – pobočka v Liberci",
      "Krajský soud v Ústí nad Labem, pobočka Liberec",
      "Krajského soudu v Ústí nad Labem – pobočky Liberce",
      "Krajský soud v Ústí nad Labem – pobočky Liberce",
    ],
    KSBRJI: [
      "Krajský soud v Brně – pobočka v Jihlavě",
      "Krajský soud v Brně, pobočka Jihlava",
    ],
    KSBR: ["Krajský soud v Brně"],
    OSBI: ["Okresní soud Brno-venkov", "Okresní soud Brno-Venkov"],
    OSKIHA: [
      "Okresní soud v Karviné – pobočka v Havířově",
      "Okresní soud v Karviné, pobočka Havířov",
    ],
    OSVSVM: [
      "Okresní soud ve Vsetíně – pobočka ve Valašském Meziříčí",
      // As printed, with the seat's last vowel short.
      "Okresní soud ve Vsetíně, pobočka Valašské Meziřičí",
    ],
    OSBUKR: [
      "Okresní soud v Bruntále – pobočka v Krnově",
      "Okresní soud v Bruntále, pobočka Krnov",
    ],
    OSKI: ["Okresní soud v Karviné"],
    NS: ["Nejvyšší soud"],
    NSS: ["Nejvyšší správní soud"],
    US: ["Ústavní soud"],
    UOHS: ["Úřad pro ochranu hospodářské soutěže"],
  },
  SVK: {
    NSSR: ["Najvyšší súd Slovenskej republiky", "Najvyšší súd"],
    NSSSR: [
      "Najvyšší správny súd Slovenskej republiky",
      "Najvyšší správny súd SR",
    ],
    USSR: ["Ústavný súd SR"],
    KSBB: ["Krajský súd v Banskej Bystrici", "Krajský súd Banská Bystrica"],
    KSBA: ["Krajský súd v Bratislave", "Krajský súd Bratislava"],
    OSBN: ["Okresný súd Bánovce nad Bebravou", "Okresný súd Bánovce n/B"],
    OSNM: ["Okresný súd Nové Mesto nad Váhom", "Okresný súd Nové Mesto n/V"],
    OSVT: ["Okresný súd Vranov nad Topľou", "Okresný súd Vranov n/T"],
    OSZH: ["Okresný súd Žiar nad Hronom", "Okresný súd Žiar n/H"],
    MSKE: ["Mestský súd Košice"],
    OSKE2: ["Okresný súd Košice II"],
  },
};

describe("a printed court name is read onto its directory court", () => {
  for (const country of PRINTED_COURT_JURISDICTIONS) {
    for (const [id, spellings] of Object.entries(PRINTED_SPELLINGS[country])) {
      test(`${country} ${id}: ${String(spellings.length)} spellings, one court`, () => {
        expect(spellings.map((printed) => idOf(country, printed))).toEqual(
          spellings.map(() => id),
        );
        // The official name is what the decision is stored under.
        expect(directoryCourtById(country, id)?.name).toBe(spellings[0]);
      });
    }
  }

  test("the spellings differ as printed, so the reading is what joins them", () => {
    for (const country of PRINTED_COURT_JURISDICTIONS) {
      for (const spellings of Object.values(PRINTED_SPELLINGS[country])) {
        expect(new Set(spellings).size).toBe(spellings.length);
      }
    }
  });

  test("a name no directory court answers to is no court, not a new one", () => {
    for (const printed of [
      "Neznámý soud 58",
      "(nezadán)",
      "Krajský soud v Atlantidě",
      "Okresní soud",
      "",
    ]) {
      expect(readPrintedCourt("CZE", printed)).toEqual({ type: "unknown" });
    }
    expect(readPrintedCourt("SVK", "Okresný súd")).toEqual({
      type: "unknown",
    });
    // A Czech court is not a Slovak one.
    expect(readPrintedCourt("SVK", "Nejvyšší soud")).toEqual({
      type: "unknown",
    });
  });

  test("a branch is not its main court, and the main court is not a branch", () => {
    expect(idOf("CZE", "Krajský soud v Hradci Králové")).toBe("KSHK");
    expect(
      idOf("CZE", "Krajský soud v Hradci Králové, pobočka Pardubice"),
    ).toBe("KSHKPA");
    expect(idOf("CZE", "Okresní soud v Pardubicích")).toBe("OSPU");
  });
});

const czechGrammar =
  courtCitationGrammarOf("CZE") ?? panic("Missing Czech court grammar");
const branchForms = czechGrammar.courts.flatMap(
  ({ id, head, seat, branch }) => {
    if (branch === undefined) {
      return [];
    }
    if (id === undefined || seat?.prepositional === undefined) {
      return panic("Incomplete branch directory");
    }
    const forms =
      czechGrammar.heads[head]?.forms ?? panic("Missing court head");
    const { preposition, form: seatForm } = seat.prepositional;
    return forms.map((form) => ({
      id,
      printed: `${form} ${preposition} ${seatForm} – pobočky ${branch.genitive}`,
      unknownBranch: `${form} ${preposition} ${seatForm} – pobočky Neznámova`,
    }));
  },
);

test.each(branchForms)(
  "an inflected Czech branch reads as its directory identity: $printed",
  ({ id, printed }) => {
    expect(idOf("CZE", printed)).toBe(id);
  },
);

test.each(branchForms)(
  "an unknown inflected branch cannot become its parent: $unknownBranch",
  ({ unknownBranch }) => {
    expect(readPrintedCourt("CZE", unknownBranch)).toEqual({ type: "unknown" });
  },
);

test("every registered Czech branch contributes its inflected forms", () => {
  expect(new Set(branchForms.map(({ id }) => id))).toEqual(
    new Set(
      czechGrammar.courts
        .filter(({ branch }) => branch !== undefined)
        .map(({ id }) => id ?? panic("A registered Czech branch has no id")),
    ),
  );
});
