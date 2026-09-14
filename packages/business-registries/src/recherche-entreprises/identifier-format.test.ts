import { describe, expect, test } from "bun:test";

import { formatSirenSpaced, formatSiretSpaced } from "./identifier-format.js";

describe("formatSirenSpaced", () => {
  test.each([
    ["552081317", "552 081 317"],
    ["000000000", "000 000 000"],
    ["999999999", "999 999 999"],
  ])("groups the SIREN %s as ddd ddd ddd", (siren, expected) => {
    expect(formatSirenSpaced(siren)).toBe(expected);
    expect(formatSirenSpaced(expected)).toBe(expected);
  });

  test.each([
    "",
    "12345678",
    "55208131700018",
    "552 081 317",
    "FR552081317",
    "55208131a",
    " 552081317",
  ])("leaves %s untouched", (siren) => {
    expect(formatSirenSpaced(siren)).toBe(siren);
  });

  test("is idempotent over every nine-digit SIREN", () => {
    for (let value = 0; value < 100_000; value += 7) {
      const siren = String(value).padStart(9, "0");
      const once = formatSirenSpaced(siren);
      expect(formatSirenSpaced(once)).toBe(once);
      expect(once.replaceAll(" ", "")).toBe(siren);
    }
  });
});

describe("formatSiretSpaced", () => {
  test.each([
    ["55208131700018", "552 081 317 00018"],
    ["00000000000000", "000 000 000 00000"],
    ["99999999999999", "999 999 999 99999"],
  ])("groups the SIRET %s as ddd ddd ddd ddddd", (siret, expected) => {
    expect(formatSiretSpaced(siret)).toBe(expected);
    expect(formatSiretSpaced(expected)).toBe(expected);
  });

  test.each([
    "",
    "552081317",
    "552081317000181",
    "552 081 317 00018",
    "FR55208131700018",
    "5520813170001a",
    " 55208131700018",
  ])("leaves %s untouched", (siret) => {
    expect(formatSiretSpaced(siret)).toBe(siret);
  });

  test("keeps the SIRET's leading SIREN grouped identically", () => {
    for (let value = 0; value < 100_000; value += 7) {
      const siren = String(value).padStart(9, "0");
      const siret = `${siren}00018`;
      const once = formatSiretSpaced(siret);
      expect(formatSiretSpaced(once)).toBe(once);
      expect(once.replaceAll(" ", "")).toBe(siret);
      expect(once.startsWith(formatSirenSpaced(siren))).toBe(true);
    }
  });
});
