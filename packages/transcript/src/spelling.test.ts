import { describe, expect, test } from "bun:test";

import { respell } from "./spelling";

// The cases of the desktop's spelling pass (dictation_spelling.rs), which
// this module must keep answering the same way.
describe("as on the desktop", () => {
  test("missing diacritics and case are restored", () => {
    expect(
      respell("dopis pro pana novaka a dvoracka", ["Nováka", "Dvořáčka"]),
    ).toBe("dopis pro pana Nováka a Dvořáčka");
  });

  test("a longer word may be a letter off", () => {
    expect(respell("smlouva s firmou Kubernetis", ["Kubernetes"])).toBe(
      "smlouva s firmou Kubernetes",
    );
    expect(respell("klient Hrdlicka", ["Hrdlička"])).toBe("klient Hrdlička");
  });

  test("a word too far off stays", () => {
    expect(respell("Nováková přijde", ["Novák"])).toBe("Nováková přijde");
    expect(respell("pan Novy", ["Novák"])).toBe("pan Novy");
  });

  test("short words change only in case or diacritics", () => {
    expect(respell("firma stll", ["STLL"])).toBe("firma STLL");
    expect(respell("firma stil", ["STLL"])).toBe("firma stil");
  });

  test("very short custom words are left alone", () => {
    expect(respell("ano, to je ono", ["ANO"])).toBe("ano, to je ono");
  });

  test("only whole words change", () => {
    expect(respell("dvorackova a dvoracek", ["Dvořák"])).toBe(
      "dvorackova a dvoracek",
    );
  });

  test("phrases match word for word", () => {
    expect(
      respell("podle smlouvy s Baker Mckenzie včera", ["Baker McKenzie"]),
    ).toBe("podle smlouvy s Baker McKenzie včera");
    expect(respell("baker mckenzie", ["Baker", "Baker McKenzie"])).toBe(
      "Baker McKenzie",
    );
    expect(respell("Baker. Mckenzie", ["Baker McKenzie"])).toBe(
      "Baker. Mckenzie",
    );
  });

  test("a word close to two custom words stays", () => {
    expect(respell("pan Kovarik", ["Kovářík", "Kovarík"])).toBe("pan Kovarik");
  });

  test("a capital at the start of a sentence stays", () => {
    expect(respell("Ebitda vzrostla.", ["EBITDA", "e-mailem"])).toBe(
      "EBITDA vzrostla.",
    );
    expect(respell("Emailem posílám.", ["e-mailem"])).toBe("E-mailem posílám.");
  });

  test("punctuation and spacing are kept", () => {
    expect(respell("„novak“, (dvorak)!", ["Novák", "Dvořák"])).toBe(
      "„Novák“, (Dvořák)!",
    );
  });

  test("the right spelling and no words change nothing", () => {
    expect(respell("pan Novák", ["Novák"])).toBe("pan Novák");
    expect(respell("pan novak", [])).toBe("pan novak");
  });

  test("numbers must match exactly", () => {
    expect(respell("podle ISO 27002", ["ISO 27001"])).toBe("podle ISO 27002");
    expect(respell("viz section 124", ["Section 123"])).toBe("viz section 124");
    expect(respell("podle iso 27001", ["ISO 27001"])).toBe("podle ISO 27001");
  });

  test("combining accents stay with their word", () => {
    expect(respell("pan José", ["José"])).toBe("pan José");
    expect(respell("pan josé", ["José"])).toBe("pan José");
    expect(respell("Dvořák", ["Dvořák"])).toBe("Dvořák");
  });

  test("a swap of two letters is one edit", () => {
    expect(respell("firma Kubrenetes", ["Kubernetes"])).toBe(
      "firma Kubernetes",
    );
  });
});

describe("case endings", () => {
  test("a name keeps the ending it was spoken with", () => {
    expect(respell("dopis pro dvoraka", ["Dvořák"])).toBe("dopis pro Dvořáka");
    expect(respell("zavolej novakovi", ["Novák"])).toBe("zavolej Novákovi");
    expect(respell("s panem Dvořákem", ["Dvořák"])).toBe("s panem Dvořákem");
  });

  test("a final vowel gives way to the ending", () => {
    expect(respell("od pani hrdlicky", ["Hrdlička"])).toBe("od pani Hrdličky");
    expect(respell("s Hrdlickou", ["Hrdlička"])).toBe("s Hrdličkou");
  });

  test("the e of -ek drops before an ending", () => {
    expect(respell("pro dvoracka", ["Dvořáček"])).toBe("pro Dvořáčka");
  });

  test("an adjective takes its endings, also inside a phrase", () => {
    expect(respell("u Nejvyssiho soudu", ["Nejvyšší soud"])).toBe(
      "u Nejvyššího soudu",
    );
    expect(respell("pana novotneho", ["Novotný"])).toBe("pana Novotného");
  });

  test("an English possessive keeps its apostrophe", () => {
    expect(respell("Mckenzie's view", ["McKenzie"])).toBe("McKenzie's view");
  });

  test("a word spelled as a custom word wins over an ending", () => {
    expect(respell("pro novaka", ["Novák", "Nováka"])).toBe("pro Nováka");
  });

  test("a short stem takes no ending", () => {
    expect(respell("velká misa", ["Mise"])).toBe("velká misa");
  });
});
