/**
 * Roles of recorded Polish decisions, read through the one Polish role
 * grammar: the recital and the legal basis introduce the ruling, the ruling
 * opens at its operative verb, the bench signs under it, a signing label
 * leaves a blank for the signature, and the reasons open under their heading
 * however the court spaced it.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { load } from "@stll/html";
import type { Block, ParagraphBlock } from "@stll/legal-ast/document-ast";
import { isDocumentAst } from "@stll/legal-ast/document-ast";
import { isPlReasonsHeading } from "@stll/legal-ast/polish-document-roles";

import {
  buildPlDecision,
  normalizeSaosDumpItem,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { assemblePlKioDecision as uncheckedAssemblePlKioDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-kio";
import { assemblePlNcourtDecision as uncheckedAssemblePlNcourtDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import { parsePlDecisionContent as uncheckedParsePlDecisionContent } from "@/api/handlers/case-law/ingestion/parsers/pl-courts";
import { readPlKioLayout } from "@/api/handlers/case-law/ingestion/parsers/pl-kio-layout";
import { parsePlKisDocumentHtml as uncheckedParsePlKisDocumentHtml } from "@/api/handlers/case-law/ingestion/parsers/pl-kis";
import { parsePlUodoDecisionXml as uncheckedParsePlUodoDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/pl-uodo";
import { structureFidelityIn } from "@/api/lib/legal-search/parsers/structure-fidelity";
import { isRecord } from "@/api/lib/type-guards";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const assemblePlKioDecision = guardParser(uncheckedAssemblePlKioDecision);
const assemblePlNcourtDecision = guardParser(uncheckedAssemblePlNcourtDecision);
const parsePlUodoDecisionXml = guardParser(uncheckedParsePlUodoDecisionXml);
const parsePlKisDocumentHtml = guardParser(uncheckedParsePlKisDocumentHtml);
const parsePlDecisionContent = guardParser(uncheckedParsePlDecisionContent);

const FIXTURES = new URL("__fixtures__/", import.meta.url);
/** Decisions recorded for their roles, read by their parser alone. */
const ROLE_FIXTURES = new URL(
  "../parsers/__fixtures__/decision-roles/",
  import.meta.url,
);

const roleFixtureText = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, ROLE_FIXTURES)).bytes()),
  );

const fixtureText = async (name: string): Promise<string> => {
  const bytes = await Bun.file(new URL(name, FIXTURES)).bytes();
  return new TextDecoder().decode(
    name.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes,
  );
};

const blocksOf = (documentAst: unknown): Block[] =>
  isDocumentAst(documentAst)
    ? documentAst.blocks
    : panic("The recorded decision has no document");

/** A SAOS detail response, read as ingestion reads it. */
const saosBlocks = async (id: string): Promise<Block[]> => {
  const payload: unknown = JSON.parse(
    await fixtureText(`pl-courts-detail-${id}.json.gz`),
  );
  const detail =
    isRecord(payload) && isRecord(payload["data"])
      ? payload["data"]
      : panic(`pl-courts-detail-${id} is not a SAOS detail`);
  const decision =
    buildPlDecision({
      listingItem: normalizeSaosDumpItem({ id: detail["id"] }),
      detail: normalizeSaosDumpItem(detail),
      rawParts: {
        "listing-dump": JSON.stringify({ id: detail["id"] }),
        detail: JSON.stringify(payload),
      },
    }) ?? panic(`pl-courts-detail-${id} builds no decision`);
  return blocksOf(decision.documentAst);
};

const kioBlocks = async (id: string): Promise<Block[]> => {
  const built = assemblePlKioDecision({
    item: { id },
    detailHtml: await fixtureText(`pl-kio-detail-${id}.html`),
    document: {
      type: "read",
      html: await fixtureText(`pl-kio-content-${id}.html.gz`),
    },
  });
  return built.type === "built"
    ? blocksOf(built.decision.documentAst)
    : panic(`KIO ${id} did not build: ${built.type}`);
};

/** A portal judgment, given the listing context the parser tests use. */
const ncourtBlocks = async (name: string): Promise<Block[]> => {
  const built = assemblePlNcourtDecision({
    listingXml:
      "<judgement><id>1</id><signature>IV Kz 73/19</signature><courtId>15502000</courtId></judgement>",
    detailXml: await fixtureText(
      "pl-ncourt-detail-151005000004027_VIII_GC_000227_2021_Uz_2021-12-23_002.xml",
    ),
    contentXml: await roleFixtureText(name),
  });
  return built.type === "built"
    ? blocksOf(built.decision.documentAst)
    : panic(`${name} did not build: ${built.type}`);
};

/** The recorded tax interpretation ITPB1/415-126/07/HDO, read by its parser. */
const kisBlocks = async (): Promise<Block[]> => {
  const payload: unknown = JSON.parse(
    await roleFixtureText("pl-kis-itpb1-415-126-07-hdo.json.gz"),
  );
  const fields =
    isRecord(payload) &&
    isRecord(payload["dokument"]) &&
    Array.isArray(payload["dokument"]["fields"])
      ? payload["dokument"]["fields"].filter(isRecord)
      : panic("the recorded interpretation has no fields");
  const value = fields.find(
    (field) => field["key"] === "TRESC_INTERESARIUSZ",
  )?.["value"];
  const html =
    typeof value === "string"
      ? value
      : panic("the recorded interpretation has no text");
  const { documentAst } = parsePlKisDocumentHtml({
    caseNumber: "ITPB1/415-126/07/HDO",
    court: "Dyrektor Izby Skarbowej w Bydgoszczy",
    decisionDate: "2007-10-23",
    decisionType: "interpretacja indywidualna",
    sourceUrl: "https://eureka.mf.gov.pl/informacje/podglad/21157",
    documentUrl: "",
    documentId: "21157",
    keywords: [],
    statutes: [],
    html,
  });
  return documentAst.blocks;
};

const paragraphs = (blocks: readonly Block[]): ParagraphBlock[] =>
  blocks.filter((block): block is ParagraphBlock => block.type === "paragraph");

const withRole = (
  blocks: readonly Block[],
  role: ParagraphBlock["role"],
): string[] =>
  paragraphs(blocks)
    .filter((block) => block.role === role)
    .map((block) => block.plainText);

/** The decision read by the role rules every source is held to. */
const roleFindings = (blocks: readonly Block[]): string[] =>
  structureFidelityIn(blocks, "pl")
    .filter(
      ({ rule }) =>
        rule === "signature-as-holding" ||
        rule === "holding-after-reasons" ||
        rule === "recital-as-holding" ||
        rule === "ruling-without-holding" ||
        rule === "instruction-as-holding" ||
        rule === "holding-after-signature",
    )
    .map(({ rule, anchorId }) => `${rule} ${anchorId}`);

describe("Polish decisions sign under their ruling", () => {
  test("I C 707/23: the judge's line under the ruling points signs it", async () => {
    const blocks = await saosBlocks("554032");

    expect(withRole(blocks, "holding")).toHaveLength(3);
    expect(withRole(blocks, "holding").at(-1)).toStartWith(
      "3. nakazuje pobrać od pozwanego",
    );
    expect(withRole(blocks, "signature")).toEqual([
      "SSO Katarzyna Banko",
      "SSO Katarzyna Banko",
    ]);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("KIO 1675/10: the chamber's label and its blank sign, and the spaced reasons heading opens the reasons", async () => {
    const blocks = await saosBlocks("116508");
    // The court prints the heading spaced out (`U z a s a d n i e n i e`).
    const reasons = blocks.findIndex(
      (block) =>
        block.type === "heading" && isPlReasonsHeading(block.plainText),
    );

    expect(blocks[reasons]).toMatchObject({
      type: "heading",
      role: "section-heading",
      plainText: "Uzasadnienie",
    });
    expect(withRole(blocks, "signature")).toEqual([
      "Skład orzekający Izby:",
      "………………………………",
      "Skład orzekający Izby:",
      "……………………………",
    ]);
    const afterReasons = paragraphs(blocks.slice(reasons + 1));
    expect(afterReasons.filter((block) => block.role === "holding")).toEqual(
      [],
    );
    expect(
      afterReasons.filter((block) => block.role === "argumentation"),
    ).toHaveLength(afterReasons.length - 2);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("KIO 1090/20: the reasons under a spaced heading are argued, and the presiding member signs", async () => {
    const blocks = await kioBlocks("13694");
    const reasons = blocks.findIndex(
      (block) =>
        block.type === "heading" && isPlReasonsHeading(block.plainText),
    );

    // The court prints the heading spaced out (`U z a s a d n i e n i e`).
    expect(blocks[reasons]?.plainText).toBe("Uzasadnienie");
    expect(withRole(blocks.slice(0, reasons), "signature")).toEqual([
      "Przewodniczący:    .............................",
    ]);
    expect(withRole(blocks.slice(reasons + 1), "holding")).toEqual([]);
    expect(
      withRole(blocks.slice(reasons + 1), "argumentation").length,
    ).toBeGreaterThan(80);
    expect(roleFindings(blocks)).toEqual([]);
  });
});

/** A judgment of the recorded SAOS dump day, read as ingestion reads it. */
const dumpDayBlocks = async (id: number): Promise<Block[]> => {
  const payload: unknown = JSON.parse(
    await fixtureText("pl-courts-dump-day.json.gz"),
  );
  const items =
    isRecord(payload) && Array.isArray(payload["items"])
      ? payload["items"].filter(isRecord)
      : panic("pl-courts-dump-day is not a SAOS dump page");
  const row =
    items.find((item) => item["id"] === id) ??
    panic(`pl-courts-dump-day lists no judgment ${id}`);
  const decision =
    buildPlDecision({
      listingItem: normalizeSaosDumpItem(row),
      detail: null,
      rawParts: { "listing-dump": JSON.stringify(row) },
    }) ?? panic(`judgment ${id} builds no decision`);
  return blocksOf(decision.documentAst);
};

describe("Polish decisions rule after their recital", () => {
  test("IV Kz 73/19: the recital printed line by line introduces the ruling, which opens at the spaced verb", async () => {
    const blocks = await ncourtBlocks("pl-ncourt-iv-kz-73-19.xml.gz");
    // The court prints the verb spaced out (`p o s t a n a w i a`).
    const verb = blocks.findIndex((block) => block.plainText === "postanawia");

    expect(blocks[verb]).toMatchObject({
      type: "heading",
      role: "section-heading",
    });
    expect(withRole(blocks.slice(0, verb), "holding")).toEqual([]);
    expect(withRole(blocks.slice(0, verb), "intro")).toEqual(
      expect.arrayContaining([
        "po rozpoznaniu w sprawie przeciwko skazanemu D. P.",
        "s. J. urodz. (...)",
        "na podstawie art. 437 § 2 kpk",
      ]),
    );
    expect(withRole(blocks, "holding")).toEqual([
      "uchylić zaskarżone postanowienie i sprawę skazanego D. P. przekazać do ponownego rozpoznania Sądowi Rejonowemu w Legnicy.",
    ]);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("ZSPU.421.3.2019: the legal basis and the recital introduce the ruling, and the reasons are argued", async () => {
    const parsed = parsePlUodoDecisionXml({
      xml: await roleFixtureText("pl-uodo-zspu-421-3-2019.xml.gz"),
      documentId: "PublicDocument-20191018-000000-000-3f8cb4bd",
      caseNumber: "ZSPU.421.3.2019",
      court: "Prezes Urzędu Ochrony Danych Osobowych",
      decisionDate: undefined,
      decisionType: "decyzja",
      sourceUrl: undefined,
    });
    const blocks = parsed.isOk()
      ? parsed.value.documentAst.blocks
      : panic(parsed.error.message);
    const body = paragraphs(blocks).filter((block) => block.note === undefined);
    const reasons = blocks.findIndex(
      (block) =>
        block.type === "heading" && isPlReasonsHeading(block.plainText),
    );

    expect(body.slice(1, 3).map((block) => block.role)).toEqual([
      "intro",
      "intro",
    ]);
    expect(body[1]?.plainText).toStartWith("Na podstawie art. 104 § 1");
    expect(body[2]?.plainText).toStartWith(
      "po przeprowadzeniu postępowania administracyjnego",
    );
    expect(body[3]).toMatchObject({ role: "holding" });
    expect(body[3]?.plainText).toStartWith("I. stwierdzając naruszenie");
    const reasonsBody = paragraphs(blocks.slice(reasons + 1)).filter(
      (block) => block.note === undefined,
    );
    expect(reasonsBody.length).toBeGreaterThan(60);
    expect(
      reasonsBody.filter(
        (block) => block.role !== "argumentation" && block.role !== "quote",
      ),
    ).toEqual([]);
    expect(roleFindings(blocks)).toEqual([]);
  });
});

describe("Polish recitals that list what they name", () => {
  test("II K 4/18: the judgments a recital lists stay in it, and the ruling opens at its own points", async () => {
    const blocks = await dumpDayBlocks(334_847);
    const holdings = withRole(blocks, "holding");

    expect(holdings.map((text) => text.slice(0, 4))).toEqual([
      "I. n",
      "II. ",
      "III.",
      "IV. ",
      "V. n",
    ]);
    expect(withRole(blocks, "intro")).toEqual(
      expect.arrayContaining([
        "J. D., s. H. i M. z d. S., ur. (...) w S.",
        "skazanego prawomocnymi wyrokami:",
      ]),
    );
    expect(
      withRole(blocks, "intro").filter((text) =>
        /^(?:[12]\)|[a-d]\))/u.test(text),
      ),
    ).toHaveLength(6);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("II K 373/17: the accused's particulars and the charge introduce the ruling", async () => {
    const blocks = await dumpDayBlocks(335_042);

    expect(withRole(blocks, "holding")[0]).toStartWith(
      "1. Oskarżonego J. J. (1) uznaje za winnego",
    );
    expect(withRole(blocks, "intro")).toEqual(
      expect.arrayContaining(["J. J. (1)", "oskarżonego o to, że:"]),
    );
    expect(roleFindings(blocks)).toEqual([]);
  });
});

describe("Polish rulings that open on their legal basis or their verb", () => {
  test("ITPB1/415-126/07/HDO: the interpretation is titled by its type and rules in its opening sentence", async () => {
    const blocks = await kisBlocks();
    const headings = blocks.flatMap((block) =>
      block.type === "heading"
        ? [`${block.role ?? "-"} ${block.plainText.trim()}`]
        : [],
    );

    expect(headings).toEqual([
      "decision-title INTERPRETACJA INDYWIDUALNA",
      "section-heading UZASADNIENIE",
    ]);
    const holdings = withRole(blocks, "holding");
    expect(holdings).toHaveLength(3);
    expect(holdings[0]).toStartWith("Na podstawie art. 14b § 1 i § 6");
    expect(holdings[0]).toContain("stwierdza, że stanowisko Pani");
    expect(holdings.slice(1).map((text) => text.trim().slice(0, 11))).toEqual([
      "w zakresie ",
      "w zakresie ",
    ]);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("VIII Ga 248/09: a bench in a composition line of its own rules, signs, and its reasons follow", async () => {
    const blocks = await kioBlocks("8247");

    expect(
      withRole(blocks, "holding").map((text) =>
        text.replaceAll(/\s+/gu, " ").slice(0, 16),
      ),
    ).toEqual(["I. oddala skargę", "II. zasądza od s"]);
    expect(withRole(blocks, "signature")).toEqual([
      "SSO Piotr Sałamaj",
      "SSO Krzysztof Górski",
    ]);
    expect(withRole(blocks, "argumentation").length).toBeGreaterThan(20);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("IV U 23/18: a point whose number runs on to its verb opens the ruling", async () => {
    const blocks = await dumpDayBlocks(336_806);

    expect(withRole(blocks, "holding").map((text) => text.slice(0, 9))).toEqual(
      ["I.zmienia", "II. zasąd"],
    );
    expect(roleFindings(blocks)).toEqual([]);
  });
});

describe("a Polish decision's docket printed again inside it", () => {
  const dockets = (blocks: readonly Block[]): string[] =>
    blocks.flatMap((block) =>
      block.plainText.startsWith("Sygn.")
        ? [
            `${block.type} ${"role" in block ? (block.role ?? "-") : "-"} ${block.plainText}`,
          ]
        : [],
    );

  test("I C 155/19: the docket between the ruling and the reasons is the docket, not a ruling point", async () => {
    const blocks = await ncourtBlocks("pl-ncourt-i-c-155-19.xml.gz");

    expect(dockets(blocks)).toEqual([
      "paragraph case-number Sygn. akt: I C 155/19",
      "paragraph case-number Sygn. akt. I C 155/19",
    ]);
    expect(withRole(blocks, "holding")).toEqual([
      "I. powództwo oddala,",
      expect.stringMatching(/^II\. zasądza od powoda na rzecz pozwanego/u),
    ]);
  });

  test("KIO 115/22: a docket the layout sets as a heading is the docket", async () => {
    const { documentAst } = parsePlDecisionContent({
      caseNumber: "KIO 115/22",
      ecli: undefined,
      court: "Krajowa Izba Odwoławcza",
      decisionDate: "2022-02-04",
      decisionType: "wyrok",
      sourceUrl: undefined,
      documentUrl: undefined,
      content: await roleFixtureText("pl-kio-content-16389.html.gz"),
      loadHtml: (source) => {
        const $ = load(source);
        readPlKioLayout($);
        return $;
      },
      keywords: [],
      statutes: [],
      documentId: "16389",
      superscripts: true,
    });

    expect(dockets(documentAst.blocks)).toEqual([
      "paragraph case-number Sygn. akt: KIO 115/22",
      "paragraph case-number Sygn. akt: KIO 115/22",
    ]);
  });
});

describe("Polish instructions on appeal are neither the ruling nor its reasons", () => {
  const instructions = (blocks: readonly Block[]): ParagraphBlock[] =>
    paragraphs(blocks).filter((block) =>
      /przysługuje(?: stronie)? (?:prawo do wniesienia )?skarg|Skargę wnosi się/u.test(
        block.plainText,
      ),
    );

  test.each(["13694", "30308"])(
    "KIO %s: the instruction under the ruling has no role, and the bench signs under it",
    async (id) => {
      const blocks = await kioBlocks(id);
      const [instruction, ...others] = instructions(blocks);

      expect(others).toEqual([]);
      expect(instruction?.plainText).toStartWith("Stosownie do art. ");
      expect(instruction?.role).toBeUndefined();
      expect(
        withRole(blocks, "holding").some((text) =>
          text.includes("przysługuje"),
        ),
      ).toBe(false);
      expect(withRole(blocks, "signature")[0]).toStartWith("Przewodniczący:");
      expect(roleFindings(blocks)).toEqual([]);
    },
  );

  test("KIO 1675/10: the instruction ends the ruling read from the common-court record", async () => {
    const blocks = await saosBlocks("116508");
    const [instruction] = instructions(blocks);

    expect(instruction?.role).toBeUndefined();
    expect(withRole(blocks, "holding")).toHaveLength(7);
    expect(roleFindings(blocks)).toEqual([]);
  });

  test("ITPB1/415-126/07/HDO: the instruction and where the remedy is filed have no role", async () => {
    const blocks = await kisBlocks();
    const found = instructions(blocks);

    expect(found.map((block) => block.plainText.trim().slice(0, 30))).toEqual([
      "Stronie przysługuje prawo do w",
      "Skargę wnosi się za pośrednict",
    ]);
    expect(found.map((block) => block.role)).toEqual([undefined, undefined]);
    // The reasons before it stay the reasons.
    expect(withRole(blocks, "argumentation").length).toBeGreaterThan(5);
  });
});
