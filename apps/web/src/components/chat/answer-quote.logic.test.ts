import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  locateQuoteInBlocks,
  quotePieces,
} from "@/components/chat/answer-quote.logic";

// Paragraphs of the Constitutional Court's III. ÚS 2429/24 (public court
// data, verbatim), and the quotations a recorded answer made from them. The
// court writes straight quotes where the answer used „…", and keeps its own
// typo ("občanského soudu řádu"): both must still count as the court's words.
const BOD_15 = `Právo na dovolání sice není ústavně zaručené, pokud je ale institut dovolání zakotven, nemůže být rozhodování o něm vyňato z ústavněprávního rámce, a to zejména co se týče práva na přístup k soudu [srov. nález ze dne 31. 10. 2023 sp. zn. III. ÚS 647/23 (N 153/120 SbNU 215) bod 27], kam spadá i posuzování subjektivní přípustnosti dovolání. Zda tedy bude dovolání posouzeno jako subjektivně přípustné či nepřípustné, se přímo dotýká ústavně zaručeného práva na přístup k soudu podle čl. 36 odst. 1 Listiny.`;
const BOD_16 = `K podání dovolání je aktivně legitimován účastník odvolacího řízení, kterému bylo alespoň zčásti nevyhověno rozhodnutím odvolacího soudu. Je-li dovolání podáno někým, kdo k dovolání není oprávněn, dovolací soud jej odmítne [§ 243c odst. 3 věta první ve spojení s § 218 písm. b) o. s. ř.]. O odmítnutí dovolání, které bylo podáno někým, kdo k dovolání není oprávněn, může rozhodnout předseda senátu dovolacího soudu nebo pověřený člen senátu (§ 243f odst. 2 o. s. ř.). Toto ustanovení upravuje i další případy, v nichž může o odmítnutí dovolání a zastavení dovolacího řízení rozhodnout samosoudce. Jeho smysl spočívá v "odbřemenění" senátu Nejvyššího soudu tam, kde podmínky pro meritorní projednání dovolání zcela jednoznačně nejsou dány. Tyto případy představují jakousi "justiční malou násobilku", zpravidla nevyžadující interpretaci práva soudem, nýbrž postačuje zcela prostá aplikace zákonných ustanovení, obsahujících podmínky řízení. Obecným pravidlem je ale rozhodování senátní (§ 36c a § 36d odst. 1 o. s. ř.), rozhodování samosoudcovské představuje výjimku z tohoto pravidla jen tam, kde to zákon výslovně připouští [srov. nález Ústavního soudu ze dne 11. 10. 2016 sp. zn. II. ÚS 849/16 (N 188/83 SbNU 81), body 32 a 36]. K přijetí usnesení o odmítnutí dovolání z důvodu, že dovolání není podle § 237 přípustné, je navíc třeba souhlasu všech členů senátu [§ 243c odst. 2 o. s. ř.].`;
const BOD_22 = `V důsledku nesprávného posouzení aktivní legitimace k podání dovolání Nejvyšší soud současně porušil i zákonná pravidla upravující obsazení soudu při rozhodování o dovolání. Rozhodování samosoudcem lze akceptovat pouze tam, kde podmínky pro meritorní projednání dovolání zcela jednoznačně nejsou dány. Posouzení přípustnosti dovolání podle § 237 o. s. ř. však představuje situaci kvalitativně odlišnou. Takové posouzení nelze redukovat na pouhé formální ověření procesních podmínek, nýbrž jde o jádro dovolacího přezkumu. Právě z tohoto důvodu občanský soudní řád vyžaduje, aby k přijetí usnesení o odmítnutí dovolání pro nepřípustnost podle § 237 o. s. ř. došlo se souhlasem všech členů senátu.`;
const BOD_24 = `Ústavní soud uzavírá, že došlo-li v posuzovaném případě k odmítnutí dovolání proto, že dovolání bylo podáno někým, kdo k dovolání není oprávněn, ačkoli měla být posuzována jeho přípustnost podle § 237 o. s. ř., došlo usnesením Nejvyššího soudu ze dne 6. srpna 2024 č. j. 27 Cdo 541/2024-681 k porušení práva stěžovatelky na přístup k soudu podle čl. 36 odst. 1 Listiny. Nejvyšší soud o dovolání stěžovatelky v důsledku tohoto postupu rozhodoval také v nesprávném složení, neboť o odmítnutí dovolání rozhodl předseda senátu podle ustanovení § 243f odst. 2 občanského soudu řádu, ačkoliv o přípustnosti dovolání měl rozhodovat v souladu s § 243c odst. 2 občanského soudního řádu tříčlenný senát. Tímto postupem bylo porušeno rovněž právo stěžovatelky na zákonného soudce podle čl. 38 odst. 1 Listiny.`;

const paragraph = (anchorId: string, number: number, text: string) =>
  ({
    anchorId,
    id: anchorId,
    inlines: [{ text, type: "text" }],
    number,
    plainText: text,
    type: "paragraph",
  }) satisfies Block;

const DECISION_BLOCKS = [
  {
    anchorId: "h-5",
    id: "h-5",
    inlines: [{ text: "V. a)", type: "text" }],
    plainText: "V. a)",
    level: 2,
    type: "heading",
  },
  paragraph("p-27", 15, BOD_15),
  paragraph("p-28", 16, BOD_16),
  paragraph("p-36", 22, BOD_22),
  paragraph("p-39", 24, BOD_24),
] satisfies Block[];

const RECORDED_QUOTES = [
  [
    `„Je-li dovolání podáno někým, kdo k dovolání není oprávněn, dovolací soud jej odmítne [§ 243c odst. 3 věta první ve spojení s § 218 písm. b) o. s. ř.]. O odmítnutí dovolání, které bylo podáno někým, kdo k dovolání není oprávněn, může rozhodnout předseda senátu dovolacího soudu nebo pověřený člen senátu (§ 243f odst. 2 o. s. ř.). Toto ustanovení upravuje i další případy, v nichž může o odmítnutí dovolání a zastavení dovolacího řízení rozhodnout samosoudce. Jeho smysl spočívá v „odbřemenění" senátu Nejvyššího soudu tam, kde podmínky pro meritorní projednání dovolání zcela jednoznačně nejsou dány. Tyto případy představují jakousi „justiční malou násobilku", zpravidla nevyžadující interpretaci práva soudem, nýbrž postačuje zcela prostá aplikace zákonných ustanovení, obsahujících podmínky řízení. Obecným pravidlem je ale rozhodování senátní (§ 36c a § 36d odst. 1 o. s. ř.), rozhodování samosoudcovské představuje výjimku z tohoto pravidla jen tam, kde to zákon výslovně připouští [srov. nález Ústavního soudu ze dne 11. 10. 2016 sp. zn. II. ÚS 849/16 (N 188/83 SbNU 81), body 32 a 36]. K přijetí usnesení o odmítnutí dovolání z důvodu, že dovolání není podle § 237 přípustné, je navíc třeba souhlasu všech členů senátu [§ 243c odst. 2 o. s. ř.]."`,
    "p-28",
    16,
  ],
  [
    `„Rozhodování samosoudcem lze akceptovat pouze tam, kde podmínky pro meritorní projednání dovolání zcela jednoznačně nejsou dány. Posouzení přípustnosti dovolání podle § 237 o. s. ř. však představuje situaci kvalitativně odlišnou. Takové posouzení nelze redukovat na pouhé formální ověření procesních podmínek, nýbrž jde o jádro dovolacího přezkumu."`,
    "p-36",
    22,
  ],
  [
    `„Právo na dovolání sice není ústavně zaručené, pokud je ale institut dovolání zakotven, nemůže být rozhodování o něm vyňato z ústavněprávního rámce, a to zejména co se týče práva na přístup k soudu […], kam spadá i posuzování subjektivní přípustnosti dovolání."`,
    "p-27",
    15,
  ],
  [
    `„Nejvyšší soud o dovolání stěžovatelky v důsledku tohoto postupu rozhodoval také v nesprávném složení, neboť o odmítnutí dovolání rozhodl předseda senátu podle ustanovení § 243f odst. 2 občanského soudu řádu, ačkoliv o přípustnosti dovolání měl rozhodovat v souladu s § 243c odst. 2 občanského soudního řádu tříčlenný senát. Tímto postupem bylo porušeno rovněž právo stěžovatelky na zákonného soudce podle čl. 38 odst. 1 Listiny."`,
    "p-39",
    24,
  ],
] as const;

describe("a quotation located in the decision", () => {
  test("each recorded quotation is the court's text, in its numbered paragraph", () => {
    for (const [quote, anchorId, number] of RECORDED_QUOTES) {
      expect(locateQuoteInBlocks(quote, DECISION_BLOCKS)).toEqual({
        anchorId,
        paragraph: number,
      });
    }
  });

  test("one changed word is a misquote, not a match", () => {
    const [quote] = RECORDED_QUOTES[0];
    const misquote = quote.replace("jej odmítne", "jej zamítne");
    expect(misquote).not.toBe(quote);
    expect(locateQuoteInBlocks(misquote, DECISION_BLOCKS)).toBeNull();
  });

  test("elided pieces must follow the court's order", () => {
    const opening = BOD_22.slice(0, 80);
    const later = BOD_22.slice(300, 380);
    expect(
      locateQuoteInBlocks(`„${opening} […] ${later}“`, DECISION_BLOCKS),
    ).toEqual({ anchorId: "p-36", paragraph: 22 });
    expect(
      locateQuoteInBlocks(`„${later} […] ${opening}“`, DECISION_BLOCKS),
    ).toBeNull();
  });

  test("a short quotation proves nothing and stays unverified", () => {
    expect(locateQuoteInBlocks("„dovolací soud“", DECISION_BLOCKS)).toBeNull();
  });
});

describe("quotation pieces", () => {
  test("drop the wrapping marks and split at elisions", () => {
    expect(quotePieces("„první část […] druhá část“")).toEqual([
      "první část",
      "druhá část",
    ]);
    expect(quotePieces('"jediná část…"')).toEqual(["jediná část"]);
  });
});
