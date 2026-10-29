import { describe, expect, test } from "bun:test";

import { caseLawSectionHeading, labelledHeading } from "./case-law-heading";

describe("case-law section heading", () => {
  test("classifies Roman sections and lettered subsections", () => {
    expect(caseLawSectionHeading("VIII. Vlastní přezkum")).toEqual({
      level: 3,
    });
    expect(caseLawSectionHeading("VIII. A) Tzv. data retention")).toEqual({
      level: 4,
    });
  });

  test("leaves prose and implausibly long labels as paragraphs", () => {
    expect(caseLawSectionHeading("Text odůvodnění.")).toBeNull();
    expect(
      caseLawSectionHeading(`I. ${"Velmi dlouhý název ".repeat(20)}`),
    ).toBeNull();
  });
});

describe("labelled heading", () => {
  test.each([
    ["I. Dovolání a vyjádření k němu", "I", "Dovolání a vyjádření k němu"],
    ["I.\nDovolání a vyjádření k němu", "I", "Dovolání a vyjádření k němu"],
    ["I.  \n  Dovolání a vyjádření k němu", "I", "Dovolání a vyjádření k němu"],
    ["4. Závěr a náklady řízení", "4", "Závěr a náklady řízení"],
    ["III.\nPřípustnost dovolání", "III", "Přípustnost dovolání"],
  ])("reads %j as one heading", (text, label, title) => {
    expect(labelledHeading(text)).toEqual({
      label,
      title,
      text: `${label}. ${title}`,
    });
  });

  test("reads a numeral and title on two lines as the same text as on one", () => {
    expect(labelledHeading("II.\nPřípustnost dovolání")?.text).toBe(
      labelledHeading("II. Přípustnost dovolání")?.text,
    );
  });

  test.each([
    "I. Dovolání obviněných se odmítá.",
    "1. Žalobce se domáhá zaplacení částky.",
    "I. Rozsudek se zrušuje;",
    "I.",
    "Dovolání a vyjádření k němu",
    "1. žalobce se domáhá",
    `I. ${"Velmi dlouhý název ".repeat(20)}`,
  ])("leaves %j to its caller as text", (text) => {
    expect(labelledHeading(text)).toBeNull();
  });
});
