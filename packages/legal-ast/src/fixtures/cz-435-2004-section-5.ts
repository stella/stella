import type { Block } from "../document-ast";

/**
 * § 5 písm. d) to f) of the Czech Employment Act (435/2004 Sb.) in the
 * consolidation in force from 1 January 2026, text verbatim from
 * https://www.e-sbirka.cz/eli/cz/sb/2004/435/2026-01-01. The publisher files
 * the sentence after point 3 under letter e)
 * (`…/par_5/pism_e/frag_6070235`) and the introductory line under the
 * section (`…/par_5/frag_6062863`), but gives neither a reader anchor.
 *
 * `filed` is the stream as a parser that keeps that parent writes it;
 * `unfiled` is the stream stored before it did, where both lines carry the
 * bare `frag_…` id and state no owner.
 */
const LEAD_IN = "Pro účely tohoto zákona se rozumí";
const CLOSING =
  "Pro posouzení toho, zda se jedná o nelegální práci, není podstatná délka výkonu této práce.";

const paragraph = (anchorId: string, text: string): Block => ({
  anchorId,
  id: anchorId,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

const section5 = (anchors: { leadIn: string; closing: string }): Block[] => [
  {
    anchorId: "par_5",
    id: "par_5",
    inlines: [{ text: "§ 5 Vymezení některých pojmů", type: "text" }],
    level: 3,
    plainText: "§ 5\nVymezení některých pojmů",
    type: "heading",
  },
  paragraph(anchors.leadIn, LEAD_IN),
  paragraph(
    "par_5-pism_d",
    "d) soustavnou přípravou na budoucí povolání doba denního studia na střední škole, konzervatoři, vyšší odborné škole a jazykové škole s právem státní jazykové zkoušky a doba prezenčního studia na vysoké škole9), a to včetně prázdnin, které jsou součástí školního nebo akademického roku,",
  ),
  paragraph(
    "par_5-pism_e",
    "e) nelegální prací práce, která má znaky závislé práce podle § 2 odst. 1 zákoníku práce a je konána",
  ),
  paragraph(
    "par_5-pism_e-bod_1",
    "1. fyzickou osobou mimo pracovněprávní vztah; to neplatí, pokud výkon této práce mimo pracovněprávní vztah umožňují jiné právní předpisy,",
  ),
  paragraph(
    "par_5-pism_e-bod_2",
    "2. cizincem v rozporu s vydaným povolením k zaměstnání nebo bez tohoto povolení, je-li podle tohoto zákona vyžadováno, nebo v rozporu se zaměstnaneckou kartou, kartou vnitropodnikově převedeného zaměstnance nebo modrou kartou vydanými podle zákona o pobytu cizinců na území České republiky nebo bez některé z těchto karet; to neplatí v případě výkonu jiné práce podle § 41 odst. 1 písm. b) zákoníku práce, nebo",
  ),
  paragraph(
    "par_5-pism_e-bod_3",
    "3. cizincem pro právnickou nebo fyzickou osobu bez platného oprávnění k pobytu na území České republiky, je-li podle zákona o pobytu cizinců na území České republiky vyžadováno.",
  ),
  paragraph(anchors.closing, CLOSING),
  paragraph(
    "par_5-pism_f",
    "f) povoláním standardizovaný souhrn pracovních činností podle jejich obvyklého seskupení na trhu práce, jejichž výkon předpokládá určitou odbornou a další způsobilost,",
  ),
  {
    anchorId: "par_5a",
    id: "par_5a",
    inlines: [{ text: "§ 5a", type: "text" }],
    level: 3,
    plainText: "§ 5a",
    type: "heading",
  },
];

export const section5Text = { leadIn: LEAD_IN, closing: CLOSING } as const;

export const section5Filed = section5({
  leadIn: "par_5-frag_6062863",
  closing: "par_5-pism_e-frag_6070235",
});

export const section5Unfiled = section5({
  leadIn: "frag_6062863",
  closing: "frag_6070235",
});
