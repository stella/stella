import type { Block } from "../document-ast";

/**
 * §§ 9 and 10 and the opening of annex 1 of 493/2026. (XI. 18.) Korm.
 * rendelet, as promulgated in Magyar Közlöny 2026. évi 173. szám, page 6299.
 * Text verbatim from that issue. Each section is a heading; § 9's points
 * continue its lead-in, and the word that closes the sentence after them is
 * filed under the section (`sz_9-szoveg_1`). Everything in the annex is filed
 * under the annex heading.
 */
const heading = (anchorId: string, text: string): Block => ({
  anchorId,
  id: anchorId,
  inlines: [{ text, type: "text" }],
  level: 3,
  plainText: text,
  type: "heading",
});

const paragraph = (anchorId: string, text: string): Block => ({
  anchorId,
  id: anchorId,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

/** The closing word after § 9's points. */
export const section9Closing = "lép.";

export const section9Blocks: readonly Block[] = [
  heading("sz_9", "9. § A 287/2006. (XII. 23.) Korm. rendelet"),
  paragraph(
    "sz_9-pont_a",
    "a) 13. § (16) bekezdésében az „az elmaradt ellátás időpontjától számított 3 napon belül” szövegrész helyébe az „a tájékoztató kézhezvételét követő 3 napon belül” szöveg,",
  ),
  paragraph(
    "sz_9-pont_b",
    "b) 13. § (23) bekezdésében a „(22)” szövegrész helyébe a „(22) és (24)” szöveg",
  ),
  paragraph("sz_9-szoveg_1", section9Closing),
  heading("sz_10", "10. §"),
  paragraph(
    "sz_10-bek_1",
    "(1) Ez a rendelet – a (2)–(4) bekezdésben foglalt kivétellel – a kihirdetését követő napon lép hatályba.",
  ),
  paragraph(
    "sz_10-bek_2",
    "(2) Az 1. § és a 7. § 2027. január 1-jén lép hatályba.",
  ),
  paragraph(
    "sz_10-bek_3",
    "(3) A 3. és 4. §, valamint az 1. melléklet 2027. április 1-jén lép hatályba.",
  ),
  paragraph(
    "sz_10-bek_4",
    "(4) A 9. § b) pontja 2027. május 1-jén lép hatályba.",
  ),
  heading("mell_1", "1. melléklet a 493/2026. (XI. 18.) Korm. rendelethez"),
  paragraph(
    "mell_1-szoveg_1",
    "„43. számú melléklet a 43/1999. (III. 3.) Korm. rendelethez",
  ),
];
