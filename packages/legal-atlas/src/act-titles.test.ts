import { describe, expect, test } from "bun:test";

import {
  actIssuedFrom,
  actKindOf,
  actTitleForms,
  isCitableActName,
  nameBeforeAmendingClause,
  pickNamedAct,
  titleHeadsFor,
} from "./act-titles";
import { CZ_PROFILE } from "./cz-provision-citation-profile";
import { SK_PROFILE } from "./sk-provision-citation-profile";

const same = (left: string, right: string) => left === right;

describe("actTitleForms", () => {
  test.each([
    ["cs", "zákon o obětech trestných činů", "zákona o obětech trestných činů"],
    ["cs", "o advokacii", "zákonem o advokacii"],
    ["cs", "vyhláška o X", "vyhláškou o X"],
    ["cs", "daňový řád", "daňového řádu"],
    ["cs", "zákoník práce", "zákoníkem práce"],
    ["cs", "soudní řád správní", "soudního řádu správního"],
    ["cs", "soudní řád správní", "soudním řádem správním"],
    ["sk", "rokovací poriadok", "rokovacieho poriadku"],
    ["sk", "o obetiach trestných činov", "zákonom o obetiach trestných činov"],
    ["sk", "správny poriadok", "správneho poriadku"],
  ])("%s %s is also printed as %s", (language, shortTitle, printed) => {
    expect(actTitleForms({ language, shortTitle })).toContain(printed);
  });

  test("only the word beside the noun agrees with it", () => {
    expect(
      actTitleForms({ language: "cs", shortTitle: "daňový řád ve znění" }),
    ).toContain("daňového řádu ve znění");
  });

  test("a language without morphology reads a title as stored", () => {
    expect(
      actTitleForms({ language: "pl", shortTitle: "o adwokaturze" }),
    ).toEqual(["o adwokaturze"]);
  });
});

describe("isCitableActName", () => {
  test.each([
    ["cs", "zákon o obětech trestných činů"],
    ["cs", "vyhláška o X"],
    ["cs", "občanský soudní řád"],
    ["cs", "soudní řád správní"],
    ["cs", "ústavní zákon o bezpečnosti"],
    ["sk", "rokovací poriadok"],
    ["cs", "zákoník práce"],
    ["sk", "zákon o obetiach trestných činov"],
    ["sk", "správny poriadok"],
  ])("%s %s is", (language, name) => {
    expect(isCitableActName(language, name)).toBe(true);
  });

  test.each([
    ["cs", "o advokacii"],
    ["cs", "o soudním řádu"],
    ["cs", "kterým se mění některé další zákony a zákon o X"],
    ["cs", "kterým se mění zákon č. 1/2000 Sb."],
    ["cs", "úplné znění zákona o X"],
    ["pl", "ustawa o adwokaturze"],
  ])("%s %s is not", (language, name) => {
    expect(isCitableActName(language, name)).toBe(false);
  });
});

describe("nameBeforeAmendingClause", () => {
  test.each([
    [
      "o ochraně osobních údajů a o změně některých zákonů",
      CZ_PROFILE.amendingClause,
      "o ochraně osobních údajů",
    ],
    [
      "o obětech trestných činů a o změně některých zákonů (zákon o obětech trestných činů)",
      CZ_PROFILE.amendingClause,
      "o obětech trestných činů",
    ],
    ["o X a o změně zákona č. 1/2000 Sb.", CZ_PROFILE.amendingClause, "o X"],
    [
      "o X a o změně občanského soudního řádu",
      CZ_PROFILE.amendingClause,
      "o X",
    ],
    ["o X a\u00A0o\nzměně některých zákonů", CZ_PROFILE.amendingClause, "o X"],
    [
      "o obetiach trestných činov a o zmene a doplnení niektorých zákonov",
      SK_PROFILE.amendingClause,
      "o obetiach trestných činov",
    ],
  ])("%s", (name, clause, expected) => {
    expect(nameBeforeAmendingClause(name, clause)).toBe(expected);
  });

  test("a name with no such clause, or nothing before it, has no shorter form", () => {
    const clause = CZ_PROFILE.amendingClause;
    expect(nameBeforeAmendingClause("o advokacii", clause)).toBeNull();
    expect(nameBeforeAmendingClause("a o změně zákonů", clause)).toBeNull();
    // A word the opener only begins is not the clause.
    expect(
      nameBeforeAmendingClause("o a o změnách v zákonech", clause),
    ).toBeNull();
    // A clause amending no act is part of the name.
    expect(
      nameBeforeAmendingClause("o ochraně ovzduší a o změně klimatu", clause),
    ).toBeNull();
  });
});

describe("actIssuedFrom", () => {
  test("reads the year off a work or expression ELI", () => {
    expect(actIssuedFrom("https://www.e-sbirka.cz/eli/cz/sb/2013/45")).toBe(
      "2013-01-01",
    );
    expect(
      actIssuedFrom("https://www.slov-lex.sk/eli/sk/zz/2017/274/2026-06-01"),
    ).toBe("2017-01-01");
    expect(actIssuedFrom("urn:no-year")).toBeNull();
  });
});

describe("pickNamedAct", () => {
  const older = { act: "a", citedFrom: "1963-01-01", citedUntil: "1976-01-01" };
  const newer = { act: "b", citedFrom: "1996-01-01", citedUntil: null };

  test("the citing date picks the act a name meant then", () => {
    const candidates = [older, newer];
    expect(
      pickNamedAct({ candidates, date: "1970-06-01", sameAct: same }),
    ).toEqual({ type: "resolved", act: "a" });
    expect(
      pickNamedAct({ candidates, date: "2026-06-01", sameAct: same }),
    ).toEqual({ type: "resolved", act: "b" });
  });

  test("two acts that fit the date name neither", () => {
    expect(
      pickNamedAct({
        candidates: [newer, { ...newer, act: "c" }],
        date: "2026-06-01",
        sameAct: same,
      }),
    ).toEqual({ type: "unresolved", reason: "ambiguous-title" });
  });

  test("versions of one act are one act", () => {
    expect(
      pickNamedAct({
        candidates: [newer, { ...newer, citedFrom: "2000-01-01" }],
        date: "2026-06-01",
        sameAct: same,
      }),
    ).toEqual({ type: "resolved", act: "b" });
  });

  test("a date outside every window, or none, names nothing", () => {
    expect(
      pickNamedAct({ candidates: [newer], date: "1990-01-01", sameAct: same }),
    ).toEqual({ type: "unresolved", reason: "title-outside-validity" });
    expect(
      pickNamedAct({ candidates: [newer], date: null, sameAct: same }),
    ).toEqual({ type: "unresolved", reason: "title-date-not-stated" });
  });
});

describe("titleHeadsFor", () => {
  test("every head lists its nominative, the statute first", () => {
    for (const language of ["cs", "sk"] as const) {
      const heads = titleHeadsFor(language);
      expect(heads.at(0)?.nominative).toBe("zákon");
      for (const head of heads) {
        expect(head.forms).toContain(head.nominative);
      }
    }
  });

  test("kinds classify the same vocabulary heads decline", () => {
    expect(actKindOf("cs", ["vyhlášky"])).toBe("decree");
    expect(actKindOf("sk", ["zákonom"])).toBe("statute");
    expect(actKindOf("pl", ["ustawa"])).toBeNull();
  });
});
