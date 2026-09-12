import { describe, expect, test } from "bun:test";

import {
  getAresCourtName,
  getAresCourtNameInstrumental,
} from "./court-names.js";

const KNOWN_COURTS = [
  ["MSPH", "Městský soud v Praze", "Městským soudem v Praze"],
  ["KSPH", "Krajský soud v Praze", "Krajským soudem v Praze"],
  [
    "KSCB",
    "Krajský soud v Českých Budějovicích",
    "Krajským soudem v Českých Budějovicích",
  ],
  [
    "KSTB",
    "Krajský soud v Českých Budějovicích – pobočka v Táboře",
    "Krajským soudem v Českých Budějovicích – pobočkou v Táboře",
  ],
  ["KSPL", "Krajský soud v Plzni", "Krajským soudem v Plzni"],
  [
    "KSKV",
    "Krajský soud v Plzni – pobočka v Karlových Varech",
    "Krajským soudem v Plzni – pobočkou v Karlových Varech",
  ],
  ["KSUL", "Krajský soud v Ústí nad Labem", "Krajským soudem v Ústí nad Labem"],
  [
    "KSLB",
    "Krajský soud v Ústí nad Labem – pobočka v Liberci",
    "Krajským soudem v Ústí nad Labem – pobočkou v Liberci",
  ],
  ["KSHK", "Krajský soud v Hradci Králové", "Krajským soudem v Hradci Králové"],
  [
    "KSPA",
    "Krajský soud v Hradci Králové – pobočka v Pardubicích",
    "Krajským soudem v Hradci Králové – pobočkou v Pardubicích",
  ],
  ["KSBR", "Krajský soud v Brně", "Krajským soudem v Brně"],
  [
    "KSJI",
    "Krajský soud v Brně – pobočka v Jihlavě",
    "Krajským soudem v Brně – pobočkou v Jihlavě",
  ],
  [
    "KSZL",
    "Krajský soud v Brně – pobočka ve Zlíně",
    "Krajským soudem v Brně – pobočkou ve Zlíně",
  ],
  ["KSOS", "Krajský soud v Ostravě", "Krajským soudem v Ostravě"],
  [
    "KSOL",
    "Krajský soud v Ostravě – pobočka v Olomouci",
    "Krajským soudem v Ostravě – pobočkou v Olomouci",
  ],
  ["VSPH", "Vrchní soud v Praze", "Vrchním soudem v Praze"],
  ["VSOL", "Vrchní soud v Olomouci", "Vrchním soudem v Olomouci"],
  ["NSCR", "Nejvyšší soud", "Nejvyšším soudem"],
] as const;

describe("ARES court names", () => {
  test.each(KNOWN_COURTS)(
    "%s resolves its nominative and instrumental names",
    (abbreviation, nominative, instrumental) => {
      expect(getAresCourtName(abbreviation)).toBe(nominative);
      expect(getAresCourtNameInstrumental(abbreviation)).toBe(instrumental);
      expect(getAresCourtNameInstrumental(nominative)).toBe(instrumental);
    },
  );

  test.each(["unknown", "toString", "constructor", "__proto__"])(
    "%s is not treated as a known court",
    (court) => {
      expect(getAresCourtName(court)).toBe(court);
      expect(getAresCourtNameInstrumental(court)).toBeNull();
    },
  );
});
