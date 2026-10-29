import type { ParagraphBlock } from "../document-ast";

/**
 * § 128 ods. 2 of the Slovak Criminal Code (300/2005 Z. z.) in the
 * consolidation in force from 18 August 2026, as the statute stores it: the
 * subsection's lead-in, its four letters, and the tail (`text2`) that closes
 * the sentence the letters continue. Slov-Lex keeps each designator, the
 * space after it and the words as separate text runs. Text verbatim from
 * https://www.slov-lex.sk/eli/sk/zz/2005/300/2026-08-18.
 */
export const section128Subsection2Blocks = [
  {
    anchorId: "paragraf-128.odsek-2",
    id: "paragraf-128.odsek-2",
    inlines: [
      { type: "text", text: "(2)" },
      { type: "text", text: " " },
      {
        type: "text",
        text: "Zahraničným verejným činiteľom sa na účely tohto zákona rozumie osoba",
      },
    ],
    plainText:
      "(2) Zahraničným verejným činiteľom sa na účely tohto zákona rozumie osoba",
    type: "paragraph",
  },
  {
    anchorId: "paragraf-128.odsek-2.pismeno-a",
    id: "paragraf-128.odsek-2.pismeno-a",
    inlines: [
      { type: "text", text: "a)" },
      { type: "text", text: " " },
      {
        type: "text",
        text: "zastávajúca funkciu v zákonodarnom orgáne, výkonnom orgáne, súdnom orgáne alebo rozhodcovskom orgáne, alebo v inom orgáne verejnej správy cudzieho štátu, vrátane hlavy štátu,",
      },
    ],
    plainText:
      "a) zastávajúca funkciu v zákonodarnom orgáne, výkonnom orgáne, súdnom orgáne alebo rozhodcovskom orgáne, alebo v inom orgáne verejnej správy cudzieho štátu, vrátane hlavy štátu,",
    type: "paragraph",
  },
  {
    anchorId: "paragraf-128.odsek-2.pismeno-b",
    id: "paragraf-128.odsek-2.pismeno-b",
    inlines: [
      { type: "text", text: "b)" },
      { type: "text", text: " " },
      {
        type: "text",
        text: "zastávajúca funkciu, vyslaná, zamestnaná alebo pracujúca v medzinárodnej organizácii alebo nadnárodnej organizácii vytvorenej štátmi alebo inými subjektmi medzinárodného práva verejného v jej orgáne alebo inštitúcii, alebo splnomocnená konať v ich mene,",
      },
    ],
    plainText:
      "b) zastávajúca funkciu, vyslaná, zamestnaná alebo pracujúca v medzinárodnej organizácii alebo nadnárodnej organizácii vytvorenej štátmi alebo inými subjektmi medzinárodného práva verejného v jej orgáne alebo inštitúcii, alebo splnomocnená konať v ich mene,",
    type: "paragraph",
  },
  {
    anchorId: "paragraf-128.odsek-2.pismeno-c",
    id: "paragraf-128.odsek-2.pismeno-c",
    inlines: [
      { type: "text", text: "c)" },
      { type: "text", text: " " },
      {
        type: "text",
        text: "zastávajúca funkciu, zamestnaná alebo pracujúca v medzinárodnom súdnom orgáne, alebo splnomocnená konať v jeho mene, alebo",
      },
    ],
    plainText:
      "c) zastávajúca funkciu, zamestnaná alebo pracujúca v medzinárodnom súdnom orgáne, alebo splnomocnená konať v jeho mene, alebo",
    type: "paragraph",
  },
  {
    anchorId: "paragraf-128.odsek-2.pismeno-d",
    id: "paragraf-128.odsek-2.pismeno-d",
    inlines: [
      { type: "text", text: "d)" },
      { type: "text", text: " " },
      {
        type: "text",
        text: "zastávajúca funkciu v právnickej osobe, v ktorej má rozhodujúci vplyv cudzí štát,",
      },
    ],
    plainText:
      "d) zastávajúca funkciu v právnickej osobe, v ktorej má rozhodujúci vplyv cudzí štát,",
    type: "paragraph",
  },
  {
    anchorId: "paragraf-128.odsek-2.text2",
    id: "paragraf-128.odsek-2.text2",
    inlines: [
      {
        type: "text",
        text: "ak je s výkonom takej funkcie spojená právomoc pri obstarávaní verejných záležitostí a trestný čin bol spáchaný v súvislosti s touto právomocou alebo prostredníctvom využitia jej postavenia.",
      },
    ],
    plainText:
      "ak je s výkonom takej funkcie spojená právomoc pri obstarávaní verejných záležitostí a trestný čin bol spáchaný v súvislosti s touto právomocou alebo prostredníctvom využitia jej postavenia.",
    type: "paragraph",
  },
] as const satisfies readonly ParagraphBlock[];
