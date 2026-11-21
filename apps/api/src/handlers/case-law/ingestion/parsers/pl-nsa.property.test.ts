import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  plNsaParagraphs,
  plNsaStatedSuperscripts,
} from "@/api/handlers/case-law/ingestion/parsers/pl-nsa";

/** Prose lines the dataset carries, each ending and opening differently. */
const PROSE = [
  "Kolegium decyzją",
  "z dnia 31 lipca",
  "2024 r.",
  "w sprawie podatku (Dz. U. z 2023 r., poz. 70 ze zm.)",
  "utrzymało w mocy zaskarżoną decyzję.",
  "Organ nie wykazał tych wad.",
  "ocena prawna",
  "Skarżący zarzucił:",
  "a) naruszenie art. 7 k.p.a.,",
  "b) art. 77 § 1 k.p.a.;",
  "xviii) art. 5 ustawy, lub",
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
  "•",
  "Polskimi",
  "Normami",
] as const;

/** Rules, page numbers, notes and primes the same columns carry. */
const FURNITURE = [
  "-----------------------",
  "-----",
  "2",
  "12",
  "ii",
  "#/32",
  "Strona 2 z 9",
  "Por. wyrok NSA.",
  "Sygn. akt I SA/Gd 604/14",
  "art. 23' § 1 Kodeksu pracy",
  "‘art. 23’ ustawy o ochronie danych",
  "'art. 23' k.p.",
] as const;

const prose = fc.array(fc.constantFrom(...PROSE), { maxLength: 24 });

const columns = fc.array(fc.constantFrom(...PROSE, ...FURNITURE), {
  maxLength: 24,
});

const visible = (text: string): string => text.replaceAll(/\s+/gu, "");

test(
  "pl-nsa paragraphs keep every character of prose",
  () => {
    assertProperty(
      "pl-nsa paragraphs keep every character of prose",
      fc.property(prose, (generated) => {
        const text = generated.join("\n\n");
        const paragraphs = plNsaParagraphs(
          text,
          plNsaStatedSuperscripts([text]),
        );
        expect(visible(paragraphs.join(""))).toBe(visible(text));
      }),
    );
  },
  propertyTestTimeout(30_000),
);

test(
  "pl-nsa paragraphs read their own output unchanged",
  () => {
    assertProperty(
      "pl-nsa paragraphs read their own output unchanged",
      fc.property(columns, (generated) => {
        const text = generated.join("\n\n");
        const stated = plNsaStatedSuperscripts([text]);
        const paragraphs = plNsaParagraphs(text, stated);
        expect(plNsaParagraphs(paragraphs.join("\n\n"), stated)).toEqual(
          paragraphs,
        );
      }),
    );
  },
  propertyTestTimeout(30_000),
);
