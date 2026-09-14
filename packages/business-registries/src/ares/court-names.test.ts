import { describe, expect, test } from "bun:test";

import {
  getAresCourtName,
  getAresCourtNameGenitive,
  getAresCourtNameInstrumental,
} from "./court-names.js";

const KNOWN_COURTS = [
  [
    "MSPH",
    "Městský soud v Praze",
    "Městským soudem v Praze",
    "Městského soudu v Praze",
  ],
  [
    "KSPH",
    "Krajský soud v Praze",
    "Krajským soudem v Praze",
    "Krajského soudu v Praze",
  ],
  [
    "KSCB",
    "Krajský soud v Českých Budějovicích",
    "Krajským soudem v Českých Budějovicích",
    "Krajského soudu v Českých Budějovicích",
  ],
  [
    "KSTB",
    "Krajský soud v Českých Budějovicích – pobočka v Táboře",
    "Krajským soudem v Českých Budějovicích – pobočkou v Táboře",
    "Krajského soudu v Českých Budějovicích – pobočky v Táboře",
  ],
  [
    "KSPL",
    "Krajský soud v Plzni",
    "Krajským soudem v Plzni",
    "Krajského soudu v Plzni",
  ],
  [
    "KSKV",
    "Krajský soud v Plzni – pobočka v Karlových Varech",
    "Krajským soudem v Plzni – pobočkou v Karlových Varech",
    "Krajského soudu v Plzni – pobočky v Karlových Varech",
  ],
  [
    "KSUL",
    "Krajský soud v Ústí nad Labem",
    "Krajským soudem v Ústí nad Labem",
    "Krajského soudu v Ústí nad Labem",
  ],
  [
    "KSLB",
    "Krajský soud v Ústí nad Labem – pobočka v Liberci",
    "Krajským soudem v Ústí nad Labem – pobočkou v Liberci",
    "Krajského soudu v Ústí nad Labem – pobočky v Liberci",
  ],
  [
    "KSHK",
    "Krajský soud v Hradci Králové",
    "Krajským soudem v Hradci Králové",
    "Krajského soudu v Hradci Králové",
  ],
  [
    "KSPA",
    "Krajský soud v Hradci Králové – pobočka v Pardubicích",
    "Krajským soudem v Hradci Králové – pobočkou v Pardubicích",
    "Krajského soudu v Hradci Králové – pobočky v Pardubicích",
  ],
  [
    "KSBR",
    "Krajský soud v Brně",
    "Krajským soudem v Brně",
    "Krajského soudu v Brně",
  ],
  [
    "KSJI",
    "Krajský soud v Brně – pobočka v Jihlavě",
    "Krajským soudem v Brně – pobočkou v Jihlavě",
    "Krajského soudu v Brně – pobočky v Jihlavě",
  ],
  [
    "KSZL",
    "Krajský soud v Brně – pobočka ve Zlíně",
    "Krajským soudem v Brně – pobočkou ve Zlíně",
    "Krajského soudu v Brně – pobočky ve Zlíně",
  ],
  [
    "KSOS",
    "Krajský soud v Ostravě",
    "Krajským soudem v Ostravě",
    "Krajského soudu v Ostravě",
  ],
  [
    "KSOL",
    "Krajský soud v Ostravě – pobočka v Olomouci",
    "Krajským soudem v Ostravě – pobočkou v Olomouci",
    "Krajského soudu v Ostravě – pobočky v Olomouci",
  ],
  [
    "VSPH",
    "Vrchní soud v Praze",
    "Vrchním soudem v Praze",
    "Vrchního soudu v Praze",
  ],
  [
    "VSOL",
    "Vrchní soud v Olomouci",
    "Vrchním soudem v Olomouci",
    "Vrchního soudu v Olomouci",
  ],
  ["NSCR", "Nejvyšší soud", "Nejvyšším soudem", "Nejvyššího soudu"],
] as const;

describe("ARES court names", () => {
  test.each(KNOWN_COURTS)(
    "%s resolves its nominative, instrumental and genitive names",
    (abbreviation, nominative, instrumental, genitive) => {
      expect(getAresCourtName(abbreviation)).toBe(nominative);
      expect(getAresCourtNameInstrumental(abbreviation)).toBe(instrumental);
      expect(getAresCourtNameInstrumental(nominative)).toBe(instrumental);
      expect(getAresCourtNameGenitive(abbreviation)).toBe(genitive);
      expect(getAresCourtNameGenitive(nominative)).toBe(genitive);
    },
  );

  test.each(["unknown", "toString", "constructor", "__proto__"])(
    "%s is not treated as a known court",
    (court) => {
      expect(getAresCourtName(court)).toBe(court);
      expect(getAresCourtNameInstrumental(court)).toBeNull();
      expect(getAresCourtNameGenitive(court)).toBeNull();
    },
  );
});
