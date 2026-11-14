import type { PreviewBlock } from "../statute-list";

/**
 * § 15 písm. b) bod 1 of the Slovak Income Tax Act (595/2003 Z. z.) in the
 * consolidation in force from 1 January 2026, as a provision read returns it:
 * a letter, a point in it, and three points in that point. Text verbatim from
 * https://www.slov-lex.sk/eli/sk/zz/2003/595/2026-01-01.
 */
export const section15LetterBPoint1Blocks = [
  {
    anchorId: "paragraf-15.pismeno-b",
    id: "paragraf-15.pismeno-b",
    text: "b) právnickú osobu",
  },
  {
    anchorId: "paragraf-15.pismeno-b.bod-1",
    id: "paragraf-15.pismeno-b.bod-1",
    text: "1. zo základu dane zníženého o daňovú stratu",
  },
  {
    anchorId: "paragraf-15.pismeno-b.bod-1.bod-1a",
    id: "paragraf-15.pismeno-b.bod-1.bod-1a",
    text: "1a. 10 % pre daňovníka, ktorý dosiahol za zdaňovacie obdobie zdaniteľné príjmy (výnosy) neprevyšujúce sumu 100 000 eur,",
  },
  {
    anchorId: "paragraf-15.pismeno-b.bod-1.bod-1b",
    id: "paragraf-15.pismeno-b.bod-1.bod-1b",
    text: "1b. 21 % pre daňovníka neuvedeného v bode 1a. alebo bode 1c.,",
  },
  {
    anchorId: "paragraf-15.pismeno-b.bod-1.bod-1c",
    id: "paragraf-15.pismeno-b.bod-1.bod-1c",
    text: "1c. 24 % pre daňovníka, ktorý dosiahol za zdaňovacie obdobie zdaniteľné príjmy (výnosy) prevyšujúce sumu 5 000 000 eur,",
  },
] as const satisfies readonly PreviewBlock[];
