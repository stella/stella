import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  plNsaParagraphs,
  plNsaStatedSuperscripts,
} from "@/api/handlers/case-law/ingestion/parsers/pl-nsa";

/** Line shapes the dataset carries, each ending and opening differently. */
const lines = fc.array(
  fc.constantFrom(
    "Kolegium decyzją",
    "z dnia 31 lipca",
    "2024 r.",
    "w sprawie podatku (Dz. U. z 2023 r., poz. 70 ze zm.)",
    "utrzymało w mocy zaskarżoną decyzję.",
    "Skarżący zarzucił:",
    "a) naruszenie art. 7 k.p.a.,",
    "b) art. 77 § 1 k.p.a.;",
    "2) art. 23¹ Kodeksu pracy, oraz",
    "3.2.7. art. 145 § 1 pkt 1 lit. c p.p.s.a.",
    "m.in. w wyrokach NSA",
    "rolno-",
    "środowiskowych oraz gospodarczo -",
    "na działce nr [...]",
    "w M.",
    "Sąd oddalił skargę.",
    "ds",
    "a.bł.",
    "12",
    "•",
    "Polskimi",
    "Normami",
  ),
  { maxLength: 24 },
);

const visible = (text: string): string => text.replaceAll(/\s+/gu, "");

test(
  "pl-nsa paragraphs keep every character and read their own output unchanged",
  () => {
    assertProperty(
      "pl-nsa paragraphs keep every character and read their own output unchanged",
      fc.property(lines, (generated) => {
        const text = generated.join("\n\n");
        const stated = plNsaStatedSuperscripts([text]);
        const paragraphs = plNsaParagraphs(text, stated);
        expect(visible(paragraphs.join(""))).toBe(visible(text));
        expect(plNsaParagraphs(paragraphs.join("\n\n"), stated)).toEqual(
          paragraphs,
        );
      }),
    );
  },
  propertyTestTimeout(30_000),
);
