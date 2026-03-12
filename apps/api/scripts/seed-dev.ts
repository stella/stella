/**
 * Seed realistic test data for local development.
 *
 * Creates contacts (organizations + people) with billing data,
 * workspaces (matters) linked to clients, properties, views,
 * entities, files (PDF/DOCX uploaded to S3), fields, workspace
 * parties, and time entries.
 *
 * Deterministic IDs via `seedId()` so re-running is idempotent
 * (uses `onConflictDoNothing()`).
 *
 * Usage:
 *   bun apps/api/scripts/seed-dev.ts
 *
 * Prerequisites:
 *   - Database running (bun run docker:dev)
 *   - Test user seeded (bun run db:seed-test-user)
 */

import "dotenv/config";
import { sql } from "drizzle-orm";

import { db } from "@/api/db";
import {
  billingCodes,
  contacts,
  entities,
  entityVersions,
  expenses,
  extractedContent,
  fields,
  invoices,
  properties,
  rateEntries,
  rateTables,
  timeEntries,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import type {
  EntityKind,
  FieldContent,
  PropertyContent,
  PropertyTool,
} from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import { s3 } from "@/api/lib/s3";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";

import { seedTemplates } from "./seed-templates";
import { ensureTestUsers } from "./seed-test-user";
import {
  ALL_USER_IDS,
  at,
  DEFAULT_ORG_ID,
  DEFAULT_USER_ID,
  pickAuthor,
  seedId,
} from "./seed-utils";

// ─── Mock file generators ───────────────────────────────

const fileExtRe = /\.(pdf|docx)$/;

const PDF_MIME = "application/pdf" as const;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

/**
 * Unicode → WinAnsiEncoding (CP1252) mapping for chars
 * outside ASCII. Helvetica supports these natively.
 *
 * Hex keys are the standard notation for Unicode code
 * points and CP1252 byte positions.
 */
const WIN_ANSI: Record<number, number> = {
  256: 0x00, // U+0100 fallback for unsupported chars
  // Latin Extended-A (Czech/Slovak/German)
  193: 0xc1, // Á
  225: 0xe1, // á
  196: 0xc4, // Ä
  228: 0xe4, // ä
  201: 0xc9, // É
  233: 0xe9, // é
  205: 0xcd, // Í
  237: 0xed, // í
  211: 0xd3, // Ó
  243: 0xf3, // ó
  212: 0xd4, // Ô
  244: 0xf4, // ô
  214: 0xd6, // Ö
  246: 0xf6, // ö
  218: 0xda, // Ú
  250: 0xfa, // ú
  220: 0xdc, // Ü
  252: 0xfc, // ü
  221: 0xdd, // Ý
  253: 0xfd, // ý
  223: 0xdf, // ß
  // Characters that need remapping to CP1252 positions
  268: 0x00, // Č → not in CP1252
  269: 0x00, // č
  270: 0x00, // Ď
  271: 0x00, // ď
  282: 0x00, // Ě
  283: 0x00, // ě
  313: 0x00, // Ĺ
  314: 0x00, // ĺ
  317: 0x00, // Ľ
  318: 0x00, // ľ
  327: 0x00, // Ň
  328: 0x00, // ň
  344: 0x00, // Ř
  345: 0x00, // ř
  352: 0x8a, // Š → CP1252 0x8A
  353: 0x9a, // š → CP1252 0x9A
  356: 0x00, // Ť
  357: 0x00, // ť
  366: 0x00, // Ů
  367: 0x00, // ů
  381: 0x8e, // Ž → CP1252 0x8E
  382: 0x9e, // ž → CP1252 0x9E
  340: 0x00, // Ŕ
  341: 0x00, // ŕ
};

// Fallback ASCII for chars not in WinAnsi
const FALLBACK: Record<string, string> = {
  Č: "C",
  č: "c",
  Ď: "D",
  ď: "d",
  Ě: "E",
  ě: "e",
  Ĺ: "L",
  ĺ: "l",
  Ľ: "L",
  ľ: "l",
  Ň: "N",
  ň: "n",
  Ř: "R",
  ř: "r",
  Ť: "T",
  ť: "t",
  Ů: "U",
  ů: "u",
  Ŕ: "R",
  ŕ: "r",
};

/** Encode a string for PDF text operators using
 *  WinAnsiEncoding. Non-encodable chars get an ASCII
 *  fallback. Returns an octal-escaped PDF string. */
const pdfEscape = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      // ASCII — escape PDF special chars
      if (ch === "\\") {
        out += "\\\\";
      } else if (ch === "(") {
        out += "\\(";
      } else if (ch === ")") {
        out += "\\)";
      } else {
        out += ch;
      }
    } else {
      const winAnsi = WIN_ANSI[cp];
      if (winAnsi && winAnsi > 0) {
        // Encodable in WinAnsi — use octal escape
        out += `\\${winAnsi.toString(8).padStart(3, "0")}`;
      } else {
        // Not in WinAnsi — ASCII fallback
        out += FALLBACK[ch] ?? "?";
      }
    }
  }
  return out;
};

/**
 * Create a minimal but readable multi-page PDF.
 * Each page holds ~45 lines at 11pt with 14pt leading.
 */
const createMockPdf = (title: string, bodyText?: string): Buffer => {
  const LINES_PER_PAGE = 45;
  const FONT_SIZE = 11;
  const LEADING = 14;
  const TITLE_SIZE = 16;
  const MARGIN_LEFT = 56;
  const TOP_Y = 740;

  // Split body text into lines, wrapping long lines at ~85 chars
  const rawLines = (bodyText ?? title).split("\n");
  const allLines: string[] = [];
  for (const raw of rawLines) {
    if (raw.length <= 85) {
      allLines.push(raw);
    } else {
      // Word-wrap
      const words = raw.split(" ");
      let line = "";
      for (const word of words) {
        if (line.length + word.length + 1 > 85) {
          allLines.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      if (line) {
        allLines.push(line);
      }
    }
  }

  // Group into pages
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) {
    pages.push([title]);
  }

  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
  ];

  // Build content streams for each page
  const pageObjIds: number[] = [];
  const contentObjStart = 4; // objects 4, 5, 6, ... are content streams
  const pageObjStart = contentObjStart + pages.length;

  for (let p = 0; p < pages.length; p++) {
    const lines = pages[p];
    let stream = "";

    // Title on first page
    if (p === 0) {
      stream +=
        `BT /F1 ${TITLE_SIZE} Tf ` +
        `${MARGIN_LEFT} ${TOP_Y} Td ` +
        `(${pdfEscape(title)}) Tj ` +
        `0 -${LEADING * 2} Td ` +
        `/F1 ${FONT_SIZE} Tf `;
    } else {
      stream += `BT /F1 ${FONT_SIZE} Tf ${MARGIN_LEFT} ${TOP_Y} Td `;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i > 0 || p > 0) {
        stream += `0 -${LEADING} Td `;
      }
      stream += `(${pdfEscape(line)}) Tj `;
    }
    stream += "ET";

    const contentId = contentObjStart + p;
    objects.push(
      `${contentId} 0 obj\n<< /Length ${stream.length} >>\n` +
        `stream\n${stream}\nendstream\nendobj`,
    );

    const pageId = pageObjStart + p;
    pageObjIds.push(pageId);
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj`,
    );
  }

  // Pages object (id 2)
  const kids = pageObjIds.map((id) => `${id} 0 R`).join(" ");
  objects.splice(
    1,
    0,
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] ` +
      `/Count ${pages.length} >>\nendobj`,
  );

  // Font object (id 3)
  objects.splice(
    2,
    0,
    "3 0 obj\n<< /Type /Font /Subtype /Type1 " +
      "/BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj",
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj}\n`;
  }

  const xrefOffset = pdf.length;
  pdf += "xref\n";
  pdf += `0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += "trailer\n";
  pdf += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += "startxref\n";
  pdf += `${xrefOffset}\n`;
  pdf += "%%EOF\n";

  return Buffer.from(pdf);
};

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const createMockDocx = async (
  title: string,
  bodyText?: string,
): Promise<Buffer> => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );

  zip
    .folder("_rels")
    ?.file(
      ".rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    );

  // Build paragraphs from body text
  const lines = (bodyText ?? title).split("\n");
  let paragraphs =
    '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>' +
    `<w:r><w:t>${xmlEscape(title)}</w:t></w:r></w:p>`;
  for (const line of lines) {
    paragraphs +=
      `<w:p><w:r><w:t xml:space="preserve">` +
      `${xmlEscape(line)}</w:t></w:r></w:p>`;
  }

  zip
    .folder("word")
    ?.file(
      "document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${paragraphs}</w:body>` +
        "</w:document>",
    );

  zip
    .folder("word")
    ?.folder("_rels")
    ?.file(
      "document.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    );

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf;
};

// ─── Document names per workspace ───────────────────────

const workspaceDocNames: Record<string, string[]> = {
  "ws-akvizice-energo": [
    "Smlouva_o_akvizici_akcii.pdf",
    "Due_Diligence_Report.pdf",
    "Plna_moc_zastupce.docx",
    "Znalecky_posudek_hodnota.pdf",
  ],
  "ws-stavebni-spor": [
    "Zaloba_o_nahradu_skody.pdf",
    "Znalecky_posudek_stavba.pdf",
    "Protokol_o_mistnim_setreni.docx",
    "Doplneni_dukazu.pdf",
  ],
  "ws-due-diligence": [
    "DD_Checklist_Legal.pdf",
    "Corporate_Structure_Chart.pdf",
    "Share_Purchase_Agreement_Draft.docx",
    "Regulatory_Compliance_Report.pdf",
  ],
  "ws-pracovni-spory": [
    "Vypoved_z_pracovniho_pomeru.pdf",
    "Odvolani_proti_rozhodnuti.pdf",
    "Pracovni_smlouva.docx",
    "Svedecka_vypoved.pdf",
  ],
  "ws-compliance-ceska-energie": [
    "Compliance_Manual_2024.pdf",
    "AML_Risk_Assessment.pdf",
    "Internal_Audit_Report.docx",
    "Compliance_Training_Materials.pdf",
  ],
  "ws-reorganizace": [
    "Reorganizacni_plan.pdf",
    "Projekt_rozdeleni.pdf",
    "Zapis_z_valneho_shromazdeni.docx",
    "Schemata_holdingove_struktury.pdf",
  ],
  "ws-cross-border": [
    "Term_Sheet_Cross_Border.pdf",
    "Regulatory_Filing_EU.pdf",
    "Merger_Agreement_Draft.docx",
    "Competition_Law_Analysis.pdf",
  ],
  "ws-gdpr-audit": [
    "GDPR_Gap_Analysis.pdf",
    "Data_Processing_Agreement.pdf",
    "Privacy_Impact_Assessment.docx",
    "Cookie_Policy_Draft.pdf",
  ],
};

/**
 * Realistic extracted text for each document. Keyed by
 * filename so the same text is reused when doc names cycle
 * across extra workspaces.
 */
const documentTexts: Record<string, string> = {
  // ws-akvizice-energo
  "Smlouva_o_akvizici_akcii.pdf": `SMLOUVA O AKVIZICI AKCIÍ

Smluvní strany:
1. Kupující: InvestCo Capital, a.s., IČO: 28456789, se sídlem Praha 1, Národní 15
2. Prodávající: EnerGo Holding, s.r.o., IČO: 25678901, se sídlem Brno, Veveří 42

Článek I – Předmět smlouvy
1.1 Prodávající převádí na Kupujícího 100 % akcií společnosti EnerGo Distribuce, a.s. (dále jen „Cílová společnost"), IČO: 27890123, zapsané v obchodním rejstříku u Krajského soudu v Brně, oddíl B, vložka 5678.
1.2 Akcie jsou kmenové, na jméno, v zaknihované podobě, o jmenovité hodnotě 1 000 Kč každá, celkový počet 50 000 ks.

Článek II – Kupní cena
2.1 Kupní cena činí 125 000 000 Kč (slovy: sto dvacet pět milionů korun českých).
2.2 Kupní cena bude uhrazena ve třech splátkách:
  a) 50 000 000 Kč do 10 pracovních dnů od podpisu této smlouvy;
  b) 50 000 000 Kč do 30 dnů po splnění odkládacích podmínek dle článku IV;
  c) 25 000 000 Kč do 90 dnů po dokončení transakce (holdback).

Článek III – Prohlášení a záruky
3.1 Prodávající prohlašuje a zaručuje, že:
  a) je výlučným vlastníkem převáděných akcií, bez jakýchkoli zástavních práv;
  b) Cílová společnost nemá žádné nesplacené závazky přesahující 5 000 000 Kč;
  c) vedené soudní spory nepřesahují částku 2 000 000 Kč.

Článek IV – Odkládací podmínky
4.1 Dokončení transakce je podmíněno:
  a) schválením Úřadem pro ochranu hospodářské soutěže;
  b) souhlasem Energetického regulačního úřadu;
  c) absencí podstatné nepříznivé změny (Material Adverse Change).

V Praze dne 15. března 2025`,

  "Due_Diligence_Report.pdf": `ZPRÁVA O PRÁVNÍ PROVĚRCE (DUE DILIGENCE)
Cílová společnost: EnerGo Distribuce, a.s.

1. SHRNUTÍ
Právní prověrka byla provedena v období 1.–28. února 2025. Celkem bylo přezkoumáno 347 dokumentů. Celkové riziko hodnotíme jako STŘEDNÍ.

2. KORPORÁTNÍ STRUKTURA
- Základní kapitál: 50 000 000 Kč, plně splacen
- Jediný akcionář: EnerGo Holding, s.r.o.
- Představenstvo: Ing. Jan Procházka (předseda), Mgr. Petra Malá
- Dozorčí rada: 3 členové, funkční období do 12/2026

3. IDENTIFIKOVANÁ RIZIKA
3.1 Vysoká rizika:
  - Licence na distribuci elektřiny vyprší 31. 12. 2025 (nutno prodloužit)
  - Probíhající řízení s ERÚ o pokutě 3 200 000 Kč za porušení podmínek licence

3.2 Střední rizika:
  - 2 pracovněprávní spory (celková expozice cca 800 000 Kč)
  - Nájemní smlouva na hlavní sídlo končí 06/2026, bez opce na prodloužení
  - Zástavní právo na transformační stanici Brno-jih (zajištění úvěru)

3.3 Nízká rizika:
  - Drobné nesrovnalosti v zápisu do katastru nemovitostí
  - Chybějící GDPR záznamy o zpracování pro 2 subdodavatele

4. DOPORUČENÍ
  a) Zajistit prodloužení licence ERÚ PŘED dokončením akvizice
  b) Vyžádat si od prodávajícího specifickou odškodňovací klauzuli na řízení ERÚ
  c) Zařadit nájemní smlouvu do seznamu smluv ke změně (change of control)

Zpracoval: Advokátní kancelář Novák & Partners
Datum: 28. února 2025`,

  "Plna_moc_zastupce.docx": `PLNÁ MOC

Já, níže podepsaný Ing. Martin Horák, dat. nar. 15. 5. 1975, bytem Praha 5, Janáčkovo nábřeží 18, jakožto jednatel společnosti InvestCo Capital, a.s., IČO: 28456789,

tímto uděluji plnou moc

JUDr. Tomáši Novákovi, advokátu, ev. č. ČAK 12456, se sídlem Praha 2, Anglická 7,

aby mě zastupoval ve všech právních úkonech souvisejících s akvizicí 100 % akcií společnosti EnerGo Distribuce, a.s., a to zejména:
- jednání s prodávajícím a jeho právními zástupci;
- podání návrhů a žádostí u ÚOHS a ERÚ;
- podpis veškerých smluvních dokumentů;
- zastupování před soudy a správními orgány.

Tato plná moc je udělena v plném rozsahu a je platná do odvolání.

V Praze dne 10. ledna 2025

Ing. Martin Horák
jednatel InvestCo Capital, a.s.`,

  "Znalecky_posudek_hodnota.pdf": `ZNALECKÝ POSUDEK č. 127-15/2025
O stanovení hodnoty 100 % akcií společnosti EnerGo Distribuce, a.s.

Znalec: doc. Ing. Karel Fiala, Ph.D., znalec v oboru ekonomika
Jmenován: Krajský soud v Praze, č.j. Spr 765/2019

ZÁVĚR:
Tržní hodnota 100 % akcií společnosti EnerGo Distribuce, a.s. k datu ocenění 31. 1. 2025 činí:

  118 500 000 Kč až 132 000 000 Kč

Střední hodnota: 125 250 000 Kč

Metoda ocenění: kombinace výnosové metody DCF entity (váha 60 %) a metody tržního porovnání (váha 40 %).

Klíčové předpoklady:
- WACC: 8,7 %
- Terminální růst: 2,0 %
- Plánované EBITDA 2025: 28 500 000 Kč
- Plánované EBITDA 2026: 31 200 000 Kč
- Multiplikátor EV/EBITDA srovnatelných společností: 4,2x–4,8x

V Praze dne 5. února 2025`,

  // ws-stavebni-spor
  "Zaloba_o_nahradu_skody.pdf": `ŽALOBA O NÁHRADU ŠKODY

Krajský soud v Ostravě
Havlíčkovo nábřeží 34
728 81 Ostrava

Žalobce: Městská správa silnic Ostrava, příspěvková organizace, IČO: 70890692
Právní zástupce: JUDr. Tomáš Novák, advokát, ev. č. ČAK 12456

Žalovaný: StavProjekt, s.r.o., IČO: 26845123, se sídlem Ostrava, Porubská 15

Žalovaná částka: 8 750 000 Kč s příslušenstvím

I. Skutkový stav
Žalovaný provedl na základě smlouvy o dílo č. 2022/0456 ze dne 15. 3. 2022 rekonstrukci mostu ev. č. 4773-1 přes řeku Odru. Dílo bylo předáno 30. 11. 2022. V dubnu 2024 byla při pravidelné prohlídce zjištěna závažná statická porucha nosné konstrukce.

II. Znalecký posudek
Dle znaleckého posudku Ing. Pavla Krejčího (č. 89-7/2024) je příčinou poruchy použití betonu nižší pevnostní třídy (C25/30 místo projektovaného C35/45) a nedostatečné krytí výztuže (18 mm místo min. 35 mm).

III. Návrh
Žalobce navrhuje, aby soud uložil žalovanému povinnost zaplatit žalobci částku 8 750 000 Kč, sestávající z:
  a) 6 500 000 Kč – náklady na sanaci;
  b) 1 250 000 Kč – náklady na provizorní omezení provozu;
  c) 1 000 000 Kč – znalecké a projektové náklady.

V Ostravě dne 20. ledna 2025`,

  "Znalecky_posudek_stavba.pdf": `ZNALECKÝ POSUDEK č. 89-7/2024
Předmět: Posouzení příčin statické poruchy mostu ev. č. 4773-1

Znalec: Ing. Pavel Krejčí, CSc., soudní znalec v oboru stavebnictví

NÁLEZ:
1. Na nosné konstrukci mostu byly identifikovány trhliny šířky 0,8–2,3 mm v oblastech maximálních ohybových momentů.
2. Jádrové vývrty prokázaly pevnost betonu v tlaku 27,3 MPa (odpovídá třídě C25/30), zatímco projekt předepisuje C35/45 (min. 45 MPa).
3. Krycí vrstva výztuže činí průměrně 18 mm, minimum dle ČSN EN 1992-1-1 pro třídu prostředí XD1 je 35 mm.

ZÁVĚR:
Příčinou zjištěných poruch je jednoznačně:
  a) použití betonu nižší pevnostní třídy;
  b) nedodržení minimálního krytí výztuže.
Obě vady jsou důsledkem nedostatečné kontroly kvality při provádění.

Odhadované náklady na sanaci: 6 200 000–6 800 000 Kč.

V Ostravě dne 15. listopadu 2024`,

  "Protokol_o_mistnim_setreni.docx": `PROTOKOL O MÍSTNÍM ŠETŘENÍ

Věc: Statická porucha mostu ev. č. 4773-1
Místo: Ostrava – Svinov, most přes Odru na silnici II/479
Datum: 8. dubna 2024, 9:00–14:30

Přítomni:
- Ing. Pavel Krejčí, CSc. – soudní znalec
- Mgr. Jan Dvořák – zástupce žalobce
- Ing. Roman Čížek – zástupce žalovaného (StavProjekt, s.r.o.)
- Bc. Marie Pokorná – stavební dozor města

Průběh šetření:
1. Vizuální prohlídka spodní stavby – zjištěny trhliny na 3 z 5 příčníků.
2. Odběr 6 jádrových vývrtů z nosné desky (vzorky V1–V6).
3. Měření tloušťky krycí vrstvy výztuže profometrem – 12 měřicích bodů.
4. Fotodokumentace – celkem 87 snímků (příloha č. 1).

Vyjádření žalovaného:
Ing. Čížek namítl, že trhliny mohly vzniknout v důsledku zvýšeného zatížení nadměrnými vozidly. Toto tvrzení bude posouzeno ve znaleckém posudku.

Protokol sepsán v Ostravě dne 8. dubna 2024.`,

  "Doplneni_dukazu.pdf": `DOPLNĚNÍ DŮKAZNÍCH NÁVRHŮ

Krajský soud v Ostravě
sp. zn. 15 C 234/2024

Žalobce tímto navrhuje provést následující důkazy:
1. Stavební deník č. 2022/0456 vedený žalovaným (k prokázání odchylek od projektu).
2. Dodací listy betonárny Cemex Ostrava za období 3–11/2022.
3. Výslech svědka Ing. Milana Březiny, stavbyvedoucího (k okolnostem změny receptury betonu).
4. Revizní zpráva TÜV SÜD Czech ze dne 22. 5. 2024.

V Ostravě dne 5. února 2025`,

  // ws-due-diligence
  "DD_Checklist_Legal.pdf": `LEGAL DUE DILIGENCE CHECKLIST

Target: TechFlow Solutions, s.r.o.
Engagement: Project Atlas – Legal DD
Date: January 2025

1. CORPORATE
  [✓] Certificate of incorporation
  [✓] Articles of association (current version)
  [✓] Shareholder register
  [✗] Board minutes for past 3 years (only 2 years provided)
  [✓] Powers of attorney

2. CONTRACTS
  [✓] Customer contracts (top 20 by revenue)
  [✓] Supplier agreements
  [✗] Change of control provisions review (in progress)
  [✓] Lease agreements

3. EMPLOYMENT
  [✓] Employment contracts (template + deviations)
  [✓] Collective bargaining agreement
  [✗] Stock option plan documentation (missing vesting schedule)
  [✓] Non-compete agreements

4. INTELLECTUAL PROPERTY
  [✓] Patent registrations (3 CZ, 1 EP)
  [✓] Trademark portfolio
  [✗] Open source license audit (pending)
  [✓] Software license agreements

5. LITIGATION
  [✓] Pending proceedings (1 minor labor dispute, EUR 15K)
  [✓] Regulatory investigations (none)
  [✓] Tax audit history

Overall completion: 78% (14/18 items)
Outstanding items require follow-up by Feb 15, 2025.`,

  "Corporate_Structure_Chart.pdf": `CORPORATE STRUCTURE – PROJECT ATLAS

TechFlow Group B.V. (Netherlands)
  │
  ├── 100% TechFlow Solutions, s.r.o. (Czech Republic)
  │     ├── 51% TechFlow Labs, s.r.o. (Czech Republic)
  │     └── 100% TechFlow Services, Kft. (Hungary)
  │
  ├── 100% TechFlow GmbH (Germany)
  │     └── 100% TechFlow Consulting AG (Switzerland)
  │
  └── 80% TechFlow UK Ltd. (United Kingdom)
        └── 100% TechFlow Ireland DAC (Ireland)

Key financial data (2024 consolidated):
- Revenue: EUR 42.3M
- EBITDA: EUR 8.1M
- Employees: 312 (CZ: 185, HU: 45, DE: 52, UK: 30)
- Net debt: EUR 3.2M

Regulatory notes:
- Czech subsidiary holds trade licenses for IT services
- Hungarian entity operates under simplified tax regime
- UK entity requires FCA notification for fintech module`,

  "Share_Purchase_Agreement_Draft.docx": `SHARE PURCHASE AGREEMENT – DRAFT v3.2

Between:
(1) TechFlow Group B.V. ("Seller")
(2) Nordic Digital Ventures AB ("Buyer")

Re: Acquisition of 100% shares in TechFlow Solutions, s.r.o.

ARTICLE 1 – DEFINITIONS
"Business Day" means any day other than Saturday, Sunday, or public holiday in the Czech Republic or the Netherlands.
"Closing Date" means the fifth Business Day after satisfaction of all Conditions Precedent.
"Material Adverse Change" means any event reducing EBITDA by more than 15% compared to the 2024 audited accounts.

ARTICLE 2 – PURCHASE PRICE
2.1 The Purchase Price shall be EUR 35,000,000 (thirty-five million euros).
2.2 The Purchase Price shall be adjusted by a locked-box mechanism with an effective date of December 31, 2024.
2.3 Permitted leakage: salaries, rent, and ordinary-course trade payables.

ARTICLE 3 – CONDITIONS PRECEDENT
3.1 Antitrust clearance from Czech ÚOHS (no Phase II referral);
3.2 Consent of key customers representing >60% of revenue;
3.3 No Material Adverse Change between signing and closing.

ARTICLE 4 – WARRANTIES
The Seller warrants that the information in the Data Room is true and complete as of the date hereof.

[REMAINDER SUBJECT TO NEGOTIATION]`,

  "Regulatory_Compliance_Report.pdf": `REGULATORY COMPLIANCE REPORT
TechFlow Solutions, s.r.o. – Project Atlas DD

1. DATA PROTECTION (GDPR)
Status: PARTIALLY COMPLIANT
- Data Processing Agreement with 12 of 15 sub-processors (3 pending)
- DPIA completed for customer analytics module
- Data breach notification procedure in place
- Missing: appointed DPO (required due to large-scale processing)
Recommendation: Appoint DPO before closing; budget EUR 45K/year

2. TRADE LICENSES
Status: COMPLIANT
- All required Czech trade licenses active and valid through 2027
- Hungarian trade license renewed in October 2024

3. EMPLOYMENT REGULATIONS
Status: COMPLIANT WITH MINOR GAPS
- Czech labor code requirements met
- Working time records: 2 instances of non-compliance in Q3 2024
- Collective bargaining agreement expires March 2026
Risk level: LOW

4. FINANCIAL REGULATION
Status: NOT APPLICABLE (fintech module not launched in CZ)
Note: UK FCA notification required if fintech module is deployed via TechFlow UK Ltd.

Overall risk rating: LOW-MEDIUM
Estimated remediation cost: EUR 65,000–85,000`,

  // ws-pracovni-spory
  "Vypoved_z_pracovniho_pomeru.pdf": `VÝPOVĚĎ Z PRACOVNÍHO POMĚRU

Zaměstnavatel: Moravské strojírny, a.s., IČO: 49567890, se sídlem Zlín, Třída Tomáše Bati 1500

Zaměstnanec: Ing. Radek Procházka, dat. nar. 3. 8. 1982, bytem Zlín, Březnická 22

Podle § 52 písm. c) zákoníku práce dáváme výpověď z pracovního poměru z důvodu organizačních změn. Na základě rozhodnutí představenstva ze dne 10. 12. 2024 se ruší pozice vedoucího oddělení technické kontroly, kterou zastáváte.

Výpovědní doba činí 2 měsíce a začne běžet prvním dnem kalendářního měsíce následujícího po doručení této výpovědi.

Odstupné: Náleží Vám odstupné ve výši trojnásobku průměrného výdělku dle § 67 odst. 1 písm. c) zákoníku práce, tj. 187 500 Kč.

Ve Zlíně dne 15. ledna 2025

Za zaměstnavatele: Ing. Josef Malý, personální ředitel`,

  "Odvolani_proti_rozhodnuti.pdf": `ODVOLÁNÍ PROTI ROZHODNUTÍ ZAMĚSTNAVATELE

Moravské strojírny, a.s.
k rukám personálního ředitele
Třída Tomáše Bati 1500, Zlín

Věc: Neplatnost výpovědi ze dne 15. 1. 2025

Já, Ing. Radek Procházka, tímto namítám neplatnost výpovědi z následujících důvodů:

1. Organizační změna nebyla skutečně realizována – pozice vedoucího technické kontroly nebyla zrušena, nýbrž přejmenována na „manažer kvality" a obsazena jiným zaměstnancem (Ing. Kopecká, nastoupila 1. 2. 2025).

2. Zaměstnavatel nedodržel povinnost nabídky jiného vhodného pracovního místa dle § 73a odst. 2 ZP, přestože v době výpovědi byla volná pozice vedoucího údržby.

3. V době doručení výpovědi jsem čerpal pracovní neschopnost (od 14. 1. 2025), výpověď tedy nemohla být platně doručena dle § 334 ZP.

Pokud zaměstnavatel neodvolá výpověď do 15 dnů, podám žalobu o určení neplatnosti výpovědi dle § 72 zákoníku práce.

Ve Zlíně dne 5. února 2025
Ing. Radek Procházka`,

  "Pracovni_smlouva.docx": `PRACOVNÍ SMLOUVA

Zaměstnavatel: Moravské strojírny, a.s., IČO: 49567890
Zaměstnanec: Ing. Radek Procházka, dat. nar. 3. 8. 1982

1. Druh práce: vedoucí oddělení technické kontroly
2. Místo výkonu práce: Zlín, Třída Tomáše Bati 1500
3. Den nástupu: 1. března 2018
4. Pracovní poměr se sjednává na dobu neurčitou
5. Zkušební doba: 3 měsíce
6. Mzda: 62 500 Kč měsíčně (mzdový výměr příloha č. 1)
7. Týdenní pracovní doba: 40 hodin
8. Dovolená: 5 týdnů ročně

Zaměstnanec potvrzuje, že byl seznámen s pracovním řádem, předpisy BOZP a interními směrnicemi zaměstnavatele.

Ve Zlíně dne 25. února 2018`,

  "Svedecka_vypoved.pdf": `SVĚDECKÁ VÝPOVĚĎ

Okresní soud ve Zlíně
sp. zn. 12 C 45/2025

Svědek: Bc. Lucie Dvořáková, dat. nar. 12. 4. 1990
Vztah k účastníkům: kolegkyně žalobce, vedoucí oddělení HR

Výpověď:
"Pracuji v Moravských strojírnách od roku 2015 jako vedoucí personálního oddělení. K organizační změně ze dne 10. 12. 2024 mohu uvést následující:

Rozhodnutí o zrušení pozice vedoucího technické kontroly připravoval finanční ředitel Ing. Kučera. Před tímto rozhodnutím jsem upozorňovala, že pan Procházka by mohl být převeden na pozici vedoucího údržby, která byla v té době neobsazena. Toto mi bylo zamítnuto s odůvodněním, že na tuto pozici je již vybrán externí kandidát.

Dne 20. ledna 2025 nastoupila na nově vytvořenou pozici 'manažer kvality' Ing. Kopecká. Náplň práce se z 80 % shoduje s původní pozicí vedoucího technické kontroly."

Svědek poučen dle § 126 o.s.ř. o povinnosti vypovídat pravdivě.

Ve Zlíně dne 10. března 2025`,

  // ws-compliance-ceska-energie
  "Compliance_Manual_2024.pdf": `COMPLIANCE MANUÁL 2024
Česká Energie, a.s.

1. ÚVOD
Tento manuál stanovuje pravidla pro dodržování regulatorních požadavků, etických norem a vnitřních předpisů společnosti Česká Energie, a.s.

2. PROTIKORUPČNÍ POLITIKA
2.1 Zákaz přijímání a poskytování úplatků dle zákona č. 40/2009 Sb. (trestní zákoník), § 331–334.
2.2 Dary a pohoštění: max. hodnota 2 000 Kč/osoba/rok, nutná evidence v registru darů.
2.3 Sponzoring: schvaluje výhradně představenstvo.

3. STŘET ZÁJMŮ
Každý zaměstnanec je povinen ohlásit střet zájmů prostřednictvím formuláře COI-01. Lhůta: 5 pracovních dnů od zjištění.

4. WHISTLEBLOWING
Oznámení lze podat:
  a) e-mailem: compliance@ceskaenergie.cz
  b) telefonicky: interní linka 5555
  c) poštou: Compliance Officer, Česká Energie, a.s., Vinohradská 100, Praha 3
Ochrana oznamovatele dle zákona č. 171/2023 Sb. je garantována.

5. SANKCE ZA PORUŠENÍ
Disciplinární řízení, výpověď, trestní oznámení dle závažnosti.

Platnost: 1. 1. 2024 – 31. 12. 2024
Schválil: Ing. Helena Marková, Chief Compliance Officer`,

  "AML_Risk_Assessment.pdf": `AML RISK ASSESSMENT
Česká Energie, a.s. – Annual Review 2024

EXECUTIVE SUMMARY
Overall AML risk rating: MEDIUM

1. CUSTOMER RISK
- Total B2B customers: 1,247
- High-risk jurisdictions: 3 customers (Russia-linked beneficial owners identified and terminated)
- PEP exposure: 2 customers flagged, enhanced due diligence applied
- KYC completion rate: 98.7%

2. PRODUCT/SERVICE RISK
- Energy trading positions: medium risk (large value, cross-border)
- Retail supply: low risk
- Green certificate trading: medium risk (new product, limited history)

3. GEOGRAPHIC RISK
- Primary operations: Czech Republic (low risk)
- Cross-border trading: Germany, Austria, Slovakia (low risk)
- Spot market participation: Leipzig EEX (medium risk due to volume)

4. TRANSACTION MONITORING
- Alerts generated (2024): 456
- Alerts escalated to MLRO: 34
- Suspicious Activity Reports filed: 2
- False positive rate: 92.5%

5. RECOMMENDATIONS
  a) Implement automated sanctions screening (current: manual, bi-weekly)
  b) Enhance UBO verification for green certificate counterparties
  c) Update customer risk scoring model (last update: 2022)

Prepared by: External AML Advisor, Deloitte Advisory s.r.o.
Date: December 2024`,

  "Internal_Audit_Report.docx": `ZPRÁVA INTERNÍHO AUDITU č. 2024/07
Česká Energie, a.s.

Oblast auditu: Proces schvalování dodavatelů
Období: Q1–Q3 2024
Auditor: Ing. Marek Vlček, CIA

ZJIŠTĚNÍ:
1. (VYSOKÁ PRIORITA) U 3 z 15 testovaných dodavatelů chybělo ověření skutečného vlastníka (UBO). Jedná se o dodavatele s kumulativním obratem 12,5 mil. Kč.

2. (STŘEDNÍ PRIORITA) Interní směrnice SM-07 vyžaduje tříkolové výběrové řízení pro zakázky nad 5 mil. Kč. U 2 zakázek bylo provedeno pouze dvoukolové řízení (zakázky č. 2024/089 a 2024/112).

3. (NÍZKÁ PRIORITA) 8 dodavatelských smluv překročilo platnost bez formálního prodloužení (auto-renewal klauzule).

DOPORUČENÍ:
1. Zavést automatickou kontrolu UBO při registraci nového dodavatele do SAP.
2. Implementovat workflow pro schvalování výjimek z SM-07.
3. Nasadit upozornění 60 dnů před expirací smlouvy.

VYJÁDŘENÍ MANAGEMENTU:
Všechna doporučení přijata. Implementace do 31. 3. 2025.`,

  "Compliance_Training_Materials.pdf": `COMPLIANCE ŠKOLENÍ 2024
Česká Energie, a.s.

Modul 1: Protikorupční pravidla
- Co je úplatek? Definice dle § 331 TZ
- Příklady zakázaného jednání
- Jak reagovat na nabídku úplatku
- Quiz: 5 otázek (min. skóre: 80 %)

Modul 2: GDPR a ochrana dat
- Práva subjektů údajů
- Jak bezpečně zacházet s osobními údaji
- Incidenty: co dělat při úniku dat
- Quiz: 5 otázek (min. skóre: 80 %)

Modul 3: Whistleblowing
- Kdy a jak podat oznámení
- Ochrana oznamovatele dle zákona č. 171/2023 Sb.
- Praktické příklady
- Quiz: 3 otázky

Statistika účasti:
- Povinní zaměstnanci: 842
- Absolvovali: 819 (97,3 %)
- Průměrné skóre: 91 %
- Zbývající termín: 31. 12. 2024`,

  // ws-reorganizace
  "Reorganizacni_plan.pdf": `REORGANIZAČNÍ PLÁN
PrůmyslPlus, a.s. – v reorganizaci

Krajský soud v Praze, sp. zn. MSPH 60 INS 4567/2024

1. ZÁKLADNÍ ÚDAJE
Dlužník: PrůmyslPlus, a.s., IČO: 25467890
Insolvenční správce: JUDr. Pavel Černý, se sídlem Praha 4
Celkové přihlášené pohledávky: 245 000 000 Kč
Zajištěné pohledávky: 120 000 000 Kč
Nezajištěné pohledávky: 125 000 000 Kč

2. NAVRHOVANÉ ŘEŠENÍ
2.1 Zajištění věřitelé obdrží 100 % svých pohledávek:
  - Splácení po dobu 5 let, úrok 3 % p.a.
  - Zajištění: zástavní právo k nemovitostem v k.ú. Hostivař

2.2 Nezajištění věřitelé obdrží 35 % svých pohledávek:
  - Jednorázová výplata do 90 dnů od schválení plánu
  - Zdroj: prodej neprovozního majetku (pozemky Uhříněves)

3. PROVOZNÍ OPATŘENÍ
  a) Snížení počtu zaměstnanců z 450 na 320
  b) Ukončení ztrátové divize povrchových úprav
  c) Restrukturalizace dodavatelského řetězce

4. HARMONOGRAM
  - Schválení věřitelským výborem: březen 2025
  - Schválení soudem: květen 2025
  - Zahájení plnění: červen 2025

Zpracoval: JUDr. Pavel Černý, insolvenční správce
Datum: 15. ledna 2025`,

  "Projekt_rozdeleni.pdf": `PROJEKT ROZDĚLENÍ ODŠTĚPENÍM

Rozdělovaná společnost: PrůmyslPlus, a.s. (v reorganizaci)
Nástupnická společnost: PrůmyslPlus Manufacturing, s.r.o. (nově zakládaná)

Dle § 243 a násl. zákona č. 125/2008 Sb. o přeměnách obchodních společností.

1. ODŠTĚPOVANÝ MAJETEK
  - Výrobní hala Hostivař (LV 4567, k.ú. Hostivař)
  - Strojní vybavení dle přílohy č. 1 (účetní hodnota 45 mil. Kč)
  - Zásoby materiálu (účetní hodnota 12 mil. Kč)
  - Pohledávky z obchodního styku (28 mil. Kč)

2. PŘECHÁZEJÍCÍ ZÁVAZKY
  - Závazky vůči dodavatelům výrobního materiálu (15 mil. Kč)
  - Pracovněprávní závazky vůči 280 zaměstnancům dle § 338 ZP

3. ZÁKLADNÍ KAPITÁL NÁSTUPNICKÉ SPOLEČNOSTI
  - 20 000 000 Kč (dvacet milionů korun českých)
  - Jediný společník: strategický investor (určen na základě výběrového řízení)

4. ROZHODNÝ DEN: 1. července 2025

Projekt schválen valnou hromadou dne 20. února 2025.`,

  "Zapis_z_valneho_shromazdeni.docx": `ZÁPIS Z MIMOŘÁDNÉ VALNÉ HROMADY
PrůmyslPlus, a.s. (v reorganizaci)

Datum: 20. února 2025, 10:00
Místo: Praha 4,Chodovská 1580/14
Přítomni: akcionáři zastupující 89,3 % základního kapitálu

Program:
1. Zahájení, volba orgánů valné hromady
2. Schválení reorganizačního plánu
3. Schválení projektu rozdělení odštěpením
4. Změna stanov
5. Různé

Usnesení č. 1: Valná hromada schvaluje reorganizační plán ze dne 15. 1. 2025.
Hlasování: pro 87,1 %, proti 2,2 %, zdržel se 0 %

Usnesení č. 2: Valná hromada schvaluje projekt rozdělení odštěpením.
Hlasování: pro 85,5 %, proti 3,8 %, zdržel se 0 %

Usnesení č. 3: Valná hromada schvaluje změnu stanov v rozsahu dle přílohy.
Hlasování: pro 89,3 %, proti 0 %, zdržel se 0 %

Zápis vyhotovil: JUDr. Anna Bílá, notářka
Notářský zápis č. NZ 112/2025`,

  "Schemata_holdingove_struktury.pdf": `SCHÉMA HOLDINGOVÉ STRUKTURY – PO REORGANIZACI

PrůmyslPlus, a.s. (mateřská společnost)
  │
  ├── 100% PrůmyslPlus Manufacturing, s.r.o.
  │     (výrobní činnost, 280 zaměstnanců)
  │
  ├── 100% PrůmyslPlus Services, s.r.o.
  │     (servis a údržba, 40 zaměstnanců)
  │
  └── 60% PrůmyslPlus Slovakia, s.r.o.
        (obchodní zastoupení pro SR, 15 zaměstnanců)

Strategický investor: vstup do PrůmyslPlus Manufacturing
  - Podíl: 70 % po kapitálovém vstupu
  - Investice: 85 000 000 Kč
  - Podmínky: zachování zaměstnanosti min. 3 roky

Časový plán restrukturalizace:
  Q2 2025: schválení soudem + zápis odštěpení
  Q3 2025: kapitálový vstup investora
  Q4 2025: dokončení reorganizace, splnění plánu`,

  // ws-cross-border
  "Term_Sheet_Cross_Border.pdf": `TERM SHEET – CROSS-BORDER ACQUISITION

Project: Project Danube
Date: January 15, 2025

Buyer: NordicAqua Industries AB (Sweden)
Target: AquaTech Central Europe, s.r.o. (Czech Republic)

1. TRANSACTION STRUCTURE
   Type: Share deal (100% acquisition)
   Consideration: EUR 28,000,000 (enterprise value)
   Adjustments: Net debt, working capital (target: EUR 4.2M)

2. KEY TERMS
   Exclusivity period: 60 days from signing
   Break fee: EUR 500,000 (mutual)
   Governing law: Czech Republic
   Arbitration: ICC Prague

3. CONDITIONS PRECEDENT
   a) Satisfactory legal, financial, and tax DD
   b) Czech antitrust clearance (ÚOHS)
   c) EU foreign subsidy regulation filing (if required)
   d) Consent of key customers (>50% revenue)
   e) No MAC between signing and closing

4. INDICATIVE TIMELINE
   DD completion: March 31, 2025
   SPA signing: April 30, 2025
   Regulatory approvals: June 30, 2025
   Closing: July 31, 2025

5. EMPLOYEE MATTERS
   Key management retention: 24-month lock-in
   No redundancies for 12 months post-closing

This Term Sheet is non-binding except for clauses 2 (exclusivity) and 2 (break fee).`,

  "Regulatory_Filing_EU.pdf": `EU REGULATORY FILING – PROJECT DANUBE

Filing Authority: European Commission, DG Competition
Filing Type: EU Foreign Subsidies Regulation (FSR), Art. 21

1. PARTIES
   Notifying Party: NordicAqua Industries AB
   - Registered: Stockholm, Sweden
   - Group revenue (2024): EUR 890M
   - Employees: 4,200

   Target: AquaTech Central Europe, s.r.o.
   - Registered: Prague, Czech Republic
   - Revenue (2024): EUR 31M
   - Employees: 145
   - Market share (CZ water treatment): ~12%

2. FOREIGN SUBSIDIES ASSESSMENT
   NordicAqua received the following financial contributions:
   a) Swedish Innovation Agency grant: EUR 2.1M (R&D, 2022–2024)
   b) EIB loan at preferential rate: EUR 15M (green infrastructure)
   c) Regional employment subsidy: EUR 800K (Gothenburg plant)

   Total financial contributions (3 years): EUR 17.9M
   Threshold for notification: EUR 50M (not met)

   CONCLUSION: Mandatory FSR notification NOT required.
   Voluntary pre-notification recommended due to:
   - Size of acquirer relative to target market
   - Strategic sector (water infrastructure)

3. CZECH ANTITRUST (ÚOHS)
   Combined market share in CZ: <15%
   Filing required: YES (turnover thresholds met)
   Expected timeline: 30 days (Phase I, no concerns anticipated)

4. MERGER CONTROL – OTHER JURISDICTIONS
   Slovakia: filing not required (no target turnover)
   Germany: filing not required (target revenue <EUR 5M in DE)
   Poland: filing not required (no operations)

Prepared by: Novák & Partners, Prague
Date: February 2025`,

  "Merger_Agreement_Draft.docx": `MERGER AGREEMENT – DRAFT v2.1
Project Danube

PARTIES:
(1) NordicAqua Industries AB, reg. no. 556789-0123, Stockholm ("Buyer")
(2) WaterTech Holding GmbH, HRB 45678, Munich ("Seller")
(3) AquaTech Central Europe, s.r.o., IČO: 04567890, Prague ("Company")

RECITALS:
(A) Seller is the sole shareholder of the Company.
(B) Buyer wishes to acquire 100% of the shares in the Company.
(C) The Parties have agreed on the terms set forth herein.

ARTICLE 1 – SALE AND PURCHASE
1.1 Subject to the terms of this Agreement, Seller sells and Buyer purchases all Shares.
1.2 The Shares are transferred free from all Encumbrances.

ARTICLE 2 – PURCHASE PRICE
2.1 Enterprise Value: EUR 28,000,000
2.2 Equity Value = Enterprise Value – Net Debt + excess Working Capital
2.3 Estimated Equity Value at Signing: EUR 24,800,000
2.4 Completion Accounts to be prepared within 60 days of Closing.

ARTICLE 3 – SELLER'S WARRANTIES
3.1 The Seller makes the warranties set out in Schedule 3.
3.2 Warranty cap: 30% of the Purchase Price (EUR 7,440,000)
3.3 De minimis threshold: EUR 50,000
3.4 Basket (deductible): EUR 250,000
3.5 Warranty period: 24 months from Closing (tax: 60 months)

[SCHEDULES TO BE ATTACHED]`,

  "Competition_Law_Analysis.pdf": `COMPETITION LAW ANALYSIS
Project Danube – NordicAqua / AquaTech

1. MARKET DEFINITION
   Relevant product market: industrial water treatment systems
   Relevant geographic market: Czech Republic (national)

2. MARKET SHARES (2024)
   Company                    | CZ Market Share
   Veolia Water Technologies  | 22%
   Xylem (Wedeco)            | 18%
   AquaTech CE (target)      | 12%
   NordicAqua (buyer)        | 3%
   Others                    | 45%

   Combined post-merger: ~15% → no dominance concern

3. HORIZONTAL OVERLAP
   Both parties active in industrial water treatment.
   Combined share <25% in all segments.
   No significant barrier to entry (multiple EU competitors).

4. VERTICAL EFFECTS
   NordicAqua supplies membrane filters used by AquaTech.
   Current share of NordicAqua in membrane supply: <8% (CZ).
   No foreclosure risk identified.

5. ASSESSMENT
   Phase I clearance expected (no serious doubts).
   No remedies anticipated.
   Filing fee: CZK 100,000

   Recommended filing date: March 15, 2025
   Expected decision: April 15, 2025

Prepared by: Novák & Partners, Prague`,

  // ws-gdpr-audit
  "GDPR_Gap_Analysis.pdf": `GDPR GAP ANALYSIS REPORT
Client: MedTech Innovations, s.r.o.

Assessment Date: January 2025
Assessor: Novák & Partners – Data Protection Practice

1. EXECUTIVE SUMMARY
   Current compliance level: 62% (target: 95%)
   Critical gaps: 4
   High-priority gaps: 7
   Medium-priority gaps: 5

2. CRITICAL GAPS
   2.1 No appointed DPO despite processing health data (Art. 37)
   2.2 Consent mechanism for clinical trial data does not meet Art. 7 requirements
   2.3 Data transfers to US cloud provider lack adequate safeguards (post-Schrems II)
   2.4 No documented data breach response procedure (Art. 33/34)

3. HIGH-PRIORITY GAPS
   3.1 Privacy notices incomplete (missing retention periods, legal basis)
   3.2 DPIA not conducted for AI diagnostic module
   3.3 Processor agreements missing with 3 of 8 sub-processors
   3.4 Records of processing activities incomplete (Art. 30)
   3.5 Employee training not conducted in past 12 months
   3.6 Right to erasure process not documented
   3.7 Cookie consent banner non-compliant (pre-checked boxes)

4. REMEDIATION TIMELINE
   Critical: 30 days
   High: 90 days
   Medium: 180 days

   Estimated total cost: EUR 45,000–65,000`,

  "Data_Processing_Agreement.pdf": `DATA PROCESSING AGREEMENT

Between:
Controller: MedTech Innovations, s.r.o., IČO: 09876543
Processor: CloudHealth Services, Inc., Delaware, USA

Pursuant to Article 28 GDPR

1. SCOPE OF PROCESSING
   Personal data categories: patient health records, diagnostic images, treatment plans
   Data subjects: patients of Controller's clients (hospitals, clinics)
   Processing purpose: cloud storage, AI-assisted diagnostics, reporting

2. PROCESSOR OBLIGATIONS
   2.1 Process data only on documented instructions from Controller
   2.2 Ensure confidentiality (all personnel under NDA)
   2.3 Implement technical measures: AES-256 encryption at rest, TLS 1.3 in transit
   2.4 Assist Controller with DPIA and data subject rights requests
   2.5 Delete all data within 30 days of contract termination

3. SUB-PROCESSORS
   Approved sub-processors:
   a) AWS (Frankfurt region) – infrastructure
   b) Datadog (EU) – monitoring
   Controller must be notified 30 days before any sub-processor change.

4. INTERNATIONAL TRANSFERS
   Transfer mechanism: EU Standard Contractual Clauses (2021/914)
   Supplementary measures: encryption, access controls, data localization option

5. AUDIT RIGHTS
   Controller may audit Processor once per year with 30 days' notice.
   SOC 2 Type II report provided annually.

Effective date: February 1, 2025`,

  "Privacy_Impact_Assessment.docx": `DATA PROTECTION IMPACT ASSESSMENT (DPIA)
MedTech Innovations – AI Diagnostic Module

1. DESCRIPTION OF PROCESSING
   The AI Diagnostic Module processes medical images (X-rays, CT scans, MRIs) to provide preliminary diagnostic suggestions to physicians.
   Data volume: ~50,000 images/month
   Storage: CloudHealth Services (AWS Frankfurt)
   Retention: 5 years (regulatory requirement)

2. NECESSITY AND PROPORTIONALITY
   Legal basis: legitimate interest (Art. 6(1)(f)) for processing; explicit consent (Art. 9(2)(a)) for health data
   Purpose limitation: diagnostic assistance only; no secondary use
   Data minimization: images pseudonymized before AI processing

3. RISKS TO DATA SUBJECTS
   3.1 HIGH: Re-identification of pseudonymized images through metadata correlation
   3.2 HIGH: Misdiagnosis leading to patient harm (not a GDPR risk per se, but relevant)
   3.3 MEDIUM: Unauthorized access to health data in transit
   3.4 LOW: Data subject unable to exercise right to explanation (Art. 22)

4. MITIGATION MEASURES
   3.1 → Strip all DICOM metadata before processing; use random patient tokens
   3.2 → AI output labeled as "preliminary suggestion"; physician review mandatory
   3.3 → End-to-end encryption; zero-trust network architecture
   3.4 → Implement explainability layer (SHAP values for model decisions)

5. DPA CONSULTATION
   Consultation with ÚOOÚ recommended due to large-scale health data processing.

Completed by: Mgr. Jana Horáková, DPO (external)
Date: January 2025`,

  "Cookie_Policy_Draft.pdf": `COOKIE POLICY – DRAFT
MedTech Innovations, s.r.o.

Last updated: January 2025

1. WHAT ARE COOKIES
   Cookies are small text files stored on your device when you visit our website (www.medtechinnovations.cz).

2. COOKIES WE USE

   Essential cookies (no consent required):
   - session_id: user authentication (expires: session)
   - csrf_token: security (expires: session)
   - cookie_consent: stores your cookie preferences (expires: 12 months)

   Analytics cookies (consent required):
   - _ga, _gid: Google Analytics – website usage statistics
   - _hjid: Hotjar – user behavior analysis

   Marketing cookies (consent required):
   - _fbp: Facebook Pixel – ad performance measurement
   - _gcl_au: Google Ads conversion tracking

3. HOW TO MANAGE COOKIES
   You can manage your preferences through our cookie banner or browser settings.
   Withdrawing consent does not affect the lawfulness of prior processing.

4. DATA TRANSFERS
   Google Analytics data may be transferred to the US. We use Google's EU data residency option where available.

5. CONTACT
   Data Protection Officer: Mgr. Jana Horáková
   Email: dpo@medtechinnovations.cz
   Supervisory authority: ÚOOÚ (www.uoou.cz)`,
};

// ─── Contacts ───────────────────────────────────────────

const orgContacts = [
  {
    id: seedId("contact-org-novak-partners"),
    type: "organization" as const,
    displayName: "Novák & Partners, s.r.o.",
    organizationName: "Novák & Partners, s.r.o.",
    registrationNumber: "27145689",
    taxId: "CZ27145689",
    bankAccounts: [
      {
        iban: "CZ6508000000192000145399",
        bic: "GIBACZPX",
        bankName: "Česká spořitelna",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Národní 60/28",
      city: "Praha",
      state: "Praha 1",
      postalCode: "110 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 4500,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "info@novak-partners.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office" as const,
        number: "+420 221 111 222",
        isPrimary: true,
      },
    ],
    color: "blue",
  },
  {
    id: seedId("contact-org-ceska-energie"),
    type: "organization" as const,
    displayName: "Česká Energie a.s.",
    organizationName: "Česká Energie a.s.",
    registrationNumber: "45274649",
    taxId: "CZ45274649",
    bankAccounts: [
      {
        iban: "CZ9501000000270100610043",
        bic: "KOMBCZPP",
        bankName: "Komerční banka",
        currency: "CZK",
      },
      {
        iban: "DE89370400440532013000",
        bic: "COBADEFFXXX",
        bankName: "Commerzbank",
        currency: "EUR",
      },
    ],
    billingAddress: {
      line1: "Vodičkova 791/41",
      city: "Praha",
      state: "Praha 1",
      postalCode: "110 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 5000,
    currency: "CZK",
    paymentTermDays: 14,
    emails: [
      {
        type: "work" as const,
        address: "legal@ceska-energie.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "office" as const,
        number: "+420 234 567 890",
        isPrimary: true,
      },
    ],
    color: "green",
  },
  {
    id: seedId("contact-org-moravska-stavebni"),
    type: "organization" as const,
    displayName: "Moravská stavební, s.r.o.",
    organizationName: "Moravská stavební, s.r.o.",
    registrationNumber: "60711086",
    taxId: "CZ60711086",
    bankAccounts: [
      {
        accountNumber: "2901761283/2010",
        bankName: "Fio banka",
        currency: "CZK",
      },
    ],
    billingAddress: {
      line1: "Masarykova 31",
      city: "Brno",
      postalCode: "602 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 3500,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "kancelar@moravska-stavebni.cz",
        isPrimary: true,
      },
    ],
    color: "orange",
  },
  {
    id: seedId("contact-org-greenleaf"),
    type: "organization" as const,
    displayName: "Greenleaf Investments Ltd.",
    organizationName: "Greenleaf Investments Ltd.",
    registrationNumber: "12345678",
    taxId: "GB123456789",
    bankAccounts: [
      {
        iban: "GB29NWBK60161331926819",
        bic: "NWBKGB2L",
        bankName: "NatWest",
        currency: "GBP",
      },
    ],
    billingAddress: {
      line1: "25 Old Broad Street",
      city: "London",
      postalCode: "EC2N 1HN",
      country: "United Kingdom",
    },
    defaultHourlyRate: 350,
    currency: "GBP",
    paymentTermDays: 45,
    emails: [
      {
        type: "work" as const,
        address: "legal@greenleaf-investments.co.uk",
        isPrimary: true,
      },
    ],
    color: "emerald",
  },
];

// Additional org contacts for overview stress-testing
const moreOrgContacts = [
  {
    id: seedId("contact-org-bratislava-legal"),
    type: "organization" as const,
    displayName: "Bratislava Legal Group, s.r.o.",
    organizationName: "Bratislava Legal Group, s.r.o.",
    registrationNumber: "36721484",
    taxId: "SK2022336611",
    billingAddress: {
      line1: "Michalská 9",
      city: "Bratislava",
      postalCode: "811 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 200,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "office@bratislava-legal.sk",
        isPrimary: true,
      },
    ],
    color: "indigo",
  },
  {
    id: seedId("contact-org-muller-bergmann"),
    type: "organization" as const,
    displayName: "Müller & Bergmann Rechtsanwälte",
    organizationName: "Müller & Bergmann Rechtsanwälte",
    registrationNumber: "HRB 123456",
    taxId: "DE987654321",
    billingAddress: {
      line1: "Friedrichstraße 44",
      city: "Berlin",
      postalCode: "10117",
      country: "Deutschland",
    },
    defaultHourlyRate: 380,
    currency: "EUR",
    paymentTermDays: 21,
    emails: [
      {
        type: "work" as const,
        address: "kanzlei@muller-bergmann.de",
        isPrimary: true,
      },
    ],
    color: "rose",
  },
  {
    id: seedId("contact-org-thames-advisory"),
    type: "organization" as const,
    displayName: "Thames Advisory Partners LLP",
    organizationName: "Thames Advisory Partners LLP",
    registrationNumber: "OC345678",
    taxId: "GB345678901",
    billingAddress: {
      line1: "1 Finsbury Avenue",
      city: "London",
      postalCode: "EC2M 2PF",
      country: "United Kingdom",
    },
    defaultHourlyRate: 450,
    currency: "GBP",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "enquiries@thames-advisory.co.uk",
        isPrimary: true,
      },
    ],
    color: "teal",
  },
  {
    id: seedId("contact-org-zilina-steel"),
    type: "organization" as const,
    displayName: "Žilina Steel Works, a.s.",
    organizationName: "Žilina Steel Works, a.s.",
    registrationNumber: "31625801",
    taxId: "SK2020459789",
    billingAddress: {
      line1: "Priemyselná 12",
      city: "Žilina",
      postalCode: "010 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 180,
    currency: "EUR",
    paymentTermDays: 45,
    emails: [
      {
        type: "work" as const,
        address: "legal@zilina-steel.sk",
        isPrimary: true,
      },
    ],
    color: "slate",
  },
  {
    id: seedId("contact-org-pragobanka"),
    type: "organization" as const,
    displayName: "PragoBanka, a.s.",
    organizationName: "PragoBanka, a.s.",
    registrationNumber: "49241257",
    taxId: "CZ49241257",
    billingAddress: {
      line1: "Senovážné náměstí 15",
      city: "Praha",
      postalCode: "110 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 5500,
    currency: "CZK",
    paymentTermDays: 14,
    emails: [
      {
        type: "work" as const,
        address: "pravni@pragobanka.cz",
        isPrimary: true,
      },
    ],
    color: "lime",
  },
  {
    id: seedId("contact-org-dunaj-pharma"),
    type: "organization" as const,
    displayName: "Dunaj Pharma, s.r.o.",
    organizationName: "Dunaj Pharma, s.r.o.",
    registrationNumber: "44556677",
    taxId: "SK2044556677",
    billingAddress: {
      line1: "Záhradnícka 46",
      city: "Bratislava",
      postalCode: "821 08",
      country: "Slovensko",
    },
    defaultHourlyRate: 220,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "legal@dunaj-pharma.sk",
        isPrimary: true,
      },
    ],
    color: "pink",
  },
  {
    id: seedId("contact-org-nord-energie"),
    type: "organization" as const,
    displayName: "Nord Energie GmbH",
    organizationName: "Nord Energie GmbH",
    registrationNumber: "HRB 789012",
    taxId: "DE789012345",
    billingAddress: {
      line1: "Am Sandtorkai 50",
      city: "Hamburg",
      postalCode: "20457",
      country: "Deutschland",
    },
    defaultHourlyRate: 320,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "recht@nord-energie.de",
        isPrimary: true,
      },
    ],
    color: "yellow",
  },
  {
    id: seedId("contact-org-ostrava-mining"),
    type: "organization" as const,
    displayName: "Ostrava Mining Corp., a.s.",
    organizationName: "Ostrava Mining Corp., a.s.",
    registrationNumber: "25831470",
    taxId: "CZ25831470",
    billingAddress: {
      line1: "Nádražní 88",
      city: "Ostrava",
      postalCode: "702 00",
      country: "Česká republika",
    },
    defaultHourlyRate: 4000,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "office@ostrava-mining.cz",
        isPrimary: true,
      },
    ],
    color: "stone",
  },
  {
    id: seedId("contact-org-crown-shipping"),
    type: "organization" as const,
    displayName: "Crown Shipping Ltd.",
    organizationName: "Crown Shipping Ltd.",
    registrationNumber: "09876543",
    taxId: "GB987654321",
    billingAddress: {
      line1: "3 Royal Exchange",
      city: "London",
      postalCode: "EC3V 3DG",
      country: "United Kingdom",
    },
    defaultHourlyRate: 400,
    currency: "GBP",
    paymentTermDays: 45,
    emails: [
      {
        type: "work" as const,
        address: "legal@crown-shipping.co.uk",
        isPrimary: true,
      },
    ],
    color: "red",
  },
  {
    id: seedId("contact-org-tatra-motors"),
    type: "organization" as const,
    displayName: "Tatra Motors, a.s.",
    organizationName: "Tatra Motors, a.s.",
    registrationNumber: "47892315",
    taxId: "CZ47892315",
    billingAddress: {
      line1: "Areál Tatra 1450",
      city: "Kopřivnice",
      postalCode: "742 21",
      country: "Česká republika",
    },
    defaultHourlyRate: 4200,
    currency: "CZK",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "pravni@tatra-motors.cz",
        isPrimary: true,
      },
    ],
    color: "purple",
  },
  {
    id: seedId("contact-org-kosice-tech"),
    type: "organization" as const,
    displayName: "Košice Tech Ventures, s.r.o.",
    organizationName: "Košice Tech Ventures, s.r.o.",
    registrationNumber: "55667788",
    taxId: "SK2055667788",
    billingAddress: {
      line1: "Hlavná 32",
      city: "Košice",
      postalCode: "040 01",
      country: "Slovensko",
    },
    defaultHourlyRate: 190,
    currency: "EUR",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "office@kosice-tech.sk",
        isPrimary: true,
      },
    ],
    color: "zinc",
  },
];

const personContacts = [
  {
    id: seedId("contact-person-jan-novak"),
    type: "person" as const,
    displayName: "JUDr. Jan Novák",
    prefix: "JUDr.",
    firstName: "Jan",
    lastName: "Novák",
    emails: [
      {
        type: "work" as const,
        address: "jan.novak@novak-partners.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile" as const,
        number: "+420 602 111 222",
        isPrimary: true,
      },
    ],
    color: "violet",
  },
  {
    id: seedId("contact-person-eva-svobodova"),
    type: "person" as const,
    displayName: "Mgr. Eva Svobodová",
    prefix: "Mgr.",
    firstName: "Eva",
    lastName: "Svobodová",
    emails: [
      {
        type: "work" as const,
        address: "eva.svobodova@ceska-energie.cz",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile" as const,
        number: "+420 603 444 555",
        isPrimary: true,
      },
    ],
    color: "fuchsia",
  },
  {
    id: seedId("contact-person-petr-dvorak"),
    type: "person" as const,
    displayName: "Ing. Petr Dvořák",
    prefix: "Ing.",
    firstName: "Petr",
    lastName: "Dvořák",
    emails: [
      {
        type: "work" as const,
        address: "dvorak@moravska-stavebni.cz",
        isPrimary: true,
      },
    ],
    color: "cyan",
  },
  {
    id: seedId("contact-person-sarah-williams"),
    type: "person" as const,
    displayName: "Sarah Williams",
    firstName: "Sarah",
    lastName: "Williams",
    emails: [
      {
        type: "work" as const,
        address: "s.williams@greenleaf-investments.co.uk",
        isPrimary: true,
      },
    ],
    phones: [
      {
        type: "mobile" as const,
        number: "+44 7700 900123",
        isPrimary: true,
      },
    ],
    color: "sky",
  },
  {
    id: seedId("contact-person-milan-kral"),
    type: "person" as const,
    displayName: "JUDr. Milan Král, Ph.D.",
    prefix: "JUDr.",
    firstName: "Milan",
    lastName: "Král",
    suffix: "Ph.D.",
    notes: "Odborník na stavební právo",
    emails: [
      {
        type: "work" as const,
        address: "kral@kral-advokat.cz",
        isPrimary: true,
      },
    ],
    color: "amber",
  },
];

// ─── Workspaces (Matters) ───────────────────────────────

const seedWorkspaces = [
  {
    id: seedId("ws-akvizice-energo"),
    name: "Akvizice EnerGo Distribuce",
    reference: "2024/001",
    clientId: at(orgContacts, 1).id, // Česká Energie
    billingReference: "CE-ACQ-2024",
  },
  {
    id: seedId("ws-stavebni-spor"),
    name: "Stavební spor - Brno Centrál",
    reference: "2024/002",
    clientId: at(orgContacts, 2).id, // Moravská stavební
    billingReference: "MS-LIT-2024",
  },
  {
    id: seedId("ws-due-diligence"),
    name: "Due Diligence - Greenleaf Fund III",
    reference: "2024/003",
    clientId: at(orgContacts, 3).id, // Greenleaf
    billingReference: "GL-DD-2024",
  },
  {
    id: seedId("ws-pracovni-spory"),
    name: "Pracovní spory - Novák",
    reference: "2024/004",
    clientId: at(orgContacts, 0).id, // Novák & Partners
  },
  {
    id: seedId("ws-compliance-ceska-energie"),
    name: "Compliance program",
    reference: "2024/005",
    clientId: at(orgContacts, 1).id, // Česká Energie
    billingReference: "CE-COMP-2024",
  },
  {
    id: seedId("ws-reorganizace"),
    name: "Reorganizace skupiny",
    reference: "2024/006",
    clientId: at(orgContacts, 0).id, // Novák & Partners
  },
  {
    id: seedId("ws-cross-border"),
    name: "Cross-border M&A Advisory",
    reference: "2024/007",
    clientId: at(orgContacts, 3).id, // Greenleaf
    billingReference: "GL-MA-2024",
  },
  {
    id: seedId("ws-gdpr-audit"),
    name: "GDPR Audit a implementace",
    reference: "2024/008",
    clientId: at(orgContacts, 2).id, // Moravská stavební
    billingReference: "MS-GDPR-2024",
  },
];

// ─── Properties (per-workspace) ─────────────────────────

type PropertySeed = {
  id: string;
  workspaceId: string;
  name: string;
  content: PropertyContent;
  tool: PropertyTool;
  system?: boolean;
  kinds?: EntityKind[];
};

const buildProperties = (wsId: string, wsLabel: string): PropertySeed[] => [
  {
    id: seedId(`${wsLabel}-prop-file`),
    workspaceId: wsId,
    name: "Documents",
    content: { version: 1, type: "file" },
    tool: { version: 1, type: "manual-input" },
    system: true,
    kinds: ["document"],
  },
  {
    id: seedId(`${wsLabel}-prop-status`),
    workspaceId: wsId,
    name: "Status",
    content: {
      version: 1,
      type: "single-select",
      options: [
        { color: "green", value: "Active" },
        { color: "amber", value: "In Review" },
        { color: "red", value: "Closed" },
        { color: "gray", value: "On Hold" },
      ],
      fallback: null,
    },
    tool: { version: 1, type: "manual-input" },
  },
  {
    id: seedId(`${wsLabel}-prop-notes`),
    workspaceId: wsId,
    name: "Notes",
    content: { version: 1, type: "text" },
    tool: { version: 1, type: "manual-input" },
  },
  {
    id: seedId(`${wsLabel}-prop-due-date`),
    workspaceId: wsId,
    name: "Due Date",
    content: { version: 1, type: "date" },
    tool: { version: 1, type: "manual-input" },
  },
];

// ─── Entities (per-workspace) ───────────────────────────

type EntitySeed = {
  entityId: string;
  versionId: string;
  workspaceId: string;
  kind: "document" | "folder";
  parentId?: string;
};

const buildEntities = (wsId: string, wsLabel: string): EntitySeed[] => {
  const folderId = seedId(`${wsLabel}-folder-1`);
  return [
    {
      entityId: folderId,
      versionId: seedId(`${wsLabel}-folder-1-v`),
      workspaceId: wsId,
      kind: "folder",
    },
    {
      entityId: seedId(`${wsLabel}-doc-1`),
      versionId: seedId(`${wsLabel}-doc-1-v`),
      workspaceId: wsId,
      kind: "document",
      parentId: folderId,
    },
    {
      entityId: seedId(`${wsLabel}-doc-2`),
      versionId: seedId(`${wsLabel}-doc-2-v`),
      workspaceId: wsId,
      kind: "document",
      parentId: folderId,
    },
    {
      entityId: seedId(`${wsLabel}-doc-3`),
      versionId: seedId(`${wsLabel}-doc-3-v`),
      workspaceId: wsId,
      kind: "document",
    },
    {
      entityId: seedId(`${wsLabel}-doc-4`),
      versionId: seedId(`${wsLabel}-doc-4-v`),
      workspaceId: wsId,
      kind: "document",
    },
  ];
};

// ─── Fields (status, due date, notes for each entity) ───

type FieldSeed = {
  id: string;
  workspaceId: string;
  propertyId: string;
  entityVersionId: string;
  content: FieldContent;
};

const statuses = ["Active", "In Review", "Closed", "On Hold"];

const notes = [
  "Awaiting client feedback on latest draft",
  "Reviewed by senior partner; minor revisions needed",
  "Final version pending signature",
  "Opposing counsel requested extension",
  "Submitted to court registry",
  "Internal review completed",
  "Client meeting scheduled to discuss terms",
  "Requires translation to English",
  "Expert opinion attached separately",
  "Pending regulatory approval",
  "Redlined version sent to counterparty",
  "Board resolution required before execution",
  "Notarization scheduled for next week",
  "Updated to reflect amended legislation",
  "Confidential; restricted distribution",
  "Cross-referenced with due diligence findings",
  "Template updated to current standards",
  "Risk assessment appended",
  "Fee estimate included in cover letter",
  "Archived after matter closure",
];

/** Deterministic future date within ~6 months of 2025-03-01. */
const seedDueDate = (index: number): string => {
  const base = new Date(2025, 2, 1); // 2025-03-01
  const offsetDays = ((index * 37 + 13) % 180) + 1; // 1..180
  base.setDate(base.getDate() + offsetDays);
  return base.toISOString().slice(0, 10);
};

const buildFields = (
  wsLabel: string,
  entitySeeds: EntitySeed[],
): FieldSeed[] => {
  const statusPropId = seedId(`${wsLabel}-prop-status`);
  const dueDatePropId = seedId(`${wsLabel}-prop-due-date`);
  const notesPropId = seedId(`${wsLabel}-prop-notes`);

  const docs = entitySeeds.filter((e) => e.kind === "document");
  const result: FieldSeed[] = [];

  for (let i = 0; i < docs.length; i++) {
    const doc = at(docs, i);

    // Status field
    result.push({
      id: seedId(`${wsLabel}-field-status-${i}`),
      workspaceId: doc.workspaceId,
      propertyId: statusPropId,
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "single-select",
        value: at(statuses, i % statuses.length),
      },
    });

    // Due Date field
    result.push({
      id: seedId(`${wsLabel}-field-due-date-${i}`),
      workspaceId: doc.workspaceId,
      propertyId: dueDatePropId,
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "date",
        value: seedDueDate(
          // Use wsLabel hash + doc index for variety
          (seedId(`${wsLabel}-${i}`).codePointAt(0) ?? 0) + i,
        ),
      },
    });

    // Notes field
    const noteIndex =
      ((seedId(`${wsLabel}-note-${i}`).codePointAt(0) ?? 0) + i) % notes.length;
    result.push({
      id: seedId(`${wsLabel}-field-notes-${i}`),
      workspaceId: doc.workspaceId,
      propertyId: notesPropId,
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "text",
        value: at(notes, noteIndex),
      },
    });
  }

  return result;
};

// ─── Workspace contacts (parties) ───────────────────────

type PartyRoleType =
  | "opposing_party"
  | "opposing_counsel"
  | "co_counsel"
  | "witness"
  | "expert_witness"
  | "third_party"
  | "judge"
  | "mediator"
  | "other";

type PartySeed = {
  id: string;
  workspaceId: string;
  contactId: string;
  role: PartyRoleType;
};

const seedParties: PartySeed[] = [
  // Akvizice EnerGo: opposing counsel + witness
  {
    id: seedId("party-akvizice-kral"),
    workspaceId: at(seedWorkspaces, 0).id,
    contactId: at(personContacts, 4).id, // Milan Král
    role: "opposing_counsel",
  },
  {
    id: seedId("party-akvizice-dvorak"),
    workspaceId: at(seedWorkspaces, 0).id,
    contactId: at(personContacts, 2).id, // Petr Dvořák
    role: "witness",
  },
  // Stavební spor: opposing party + judge
  {
    id: seedId("party-stavebni-novak-partners"),
    workspaceId: at(seedWorkspaces, 1).id,
    contactId: at(orgContacts, 0).id, // Novák & Partners
    role: "opposing_party",
  },
  {
    id: seedId("party-stavebni-kral"),
    workspaceId: at(seedWorkspaces, 1).id,
    contactId: at(personContacts, 4).id, // Milan Král
    role: "judge",
  },
  // Due Diligence: co-counsel
  {
    id: seedId("party-dd-novak"),
    workspaceId: at(seedWorkspaces, 2).id,
    contactId: at(personContacts, 0).id, // Jan Novák
    role: "co_counsel",
  },
  // Cross-border M&A: expert witness
  {
    id: seedId("party-crossborder-svobodova"),
    workspaceId: at(seedWorkspaces, 6).id,
    contactId: at(personContacts, 1).id, // Eva Svobodová
    role: "expert_witness",
  },
  // GDPR Audit: third party
  {
    id: seedId("party-gdpr-williams"),
    workspaceId: at(seedWorkspaces, 7).id,
    contactId: at(personContacts, 3).id, // Sarah Williams
    role: "third_party",
  },
  // Pracovní spory: opposing counsel
  {
    id: seedId("party-pracovni-svobodova"),
    workspaceId: at(seedWorkspaces, 3).id,
    contactId: at(personContacts, 1).id, // Eva Svobodová
    role: "opposing_counsel",
  },
];

// ─── Billing codes ─────────────────────────────────────

const TASK_CODES = [
  { code: "RESEARCH", label: "Legal research" },
  { code: "REVIEW", label: "Document review" },
  { code: "DRAFT", label: "Drafting" },
  { code: "MEETING", label: "Meeting / conference" },
  { code: "COURT", label: "Court appearance" },
  { code: "FILING", label: "Filing and service" },
  { code: "DISCOVERY", label: "Discovery" },
  { code: "NEGOTIATE", label: "Negotiation" },
  { code: "ADVISE", label: "Advisory" },
  { code: "ADMIN", label: "Administrative" },
] as const;

const ACTIVITY_CODES = [
  { code: "PLAN", label: "Planning and strategy" },
  { code: "COMMUNICATE", label: "Communication" },
  { code: "ANALYZE", label: "Analysis" },
  { code: "MANAGE", label: "Case management" },
  { code: "TRAVEL", label: "Travel" },
  { code: "ATTEND", label: "Attendance" },
  { code: "PREPARE", label: "Preparation" },
  { code: "CORRESPOND", label: "Correspondence" },
] as const;

type BillingCodeSeed = {
  id: string;
  workspaceId: string;
  type: "task" | "activity";
  code: string;
  label: string;
  sortOrder: number;
};

const buildBillingCodes = (): BillingCodeSeed[] => {
  const codes: BillingCodeSeed[] = [];
  for (let wsIndex = 0; wsIndex < seedWorkspaces.length; wsIndex++) {
    const ws = at(seedWorkspaces, wsIndex);
    for (let i = 0; i < TASK_CODES.length; i++) {
      const tc = at(TASK_CODES, i);
      codes.push({
        id: seedId(`billing-code-${wsIndex}-task-${tc.code}`),
        workspaceId: ws.id,
        type: "task",
        code: tc.code,
        label: tc.label,
        sortOrder: i,
      });
    }
    for (let i = 0; i < ACTIVITY_CODES.length; i++) {
      const ac = at(ACTIVITY_CODES, i);
      codes.push({
        id: seedId(`billing-code-${wsIndex}-activity-${ac.code}`),
        workspaceId: ws.id,
        type: "activity",
        code: ac.code,
        label: ac.label,
        sortOrder: i,
      });
    }
  }
  return codes;
};

// ─── Rate tables ───────────────────────────────────────

type RateTableSeed = {
  id: string;
  workspaceId: string;
  name: string;
  currency: string;
};

type RateEntrySeed = {
  id: string;
  workspaceId: string;
  rateTableId: string;
  userId: string;
  hourlyRate: number;
  effectiveFrom: string;
};

/** Tiered hourly rates (CZK) by user seniority */
const USER_RATES: Record<string, number> = {
  "test-user-stella-dev": 6500,
  "test-user-alice-johnson": 4500,
  "test-user-bob-martinez": 2500,
  "test-user-clara-novak": 4500,
  "test-user-david-kim": 6500,
  "test-user-eva-schmidt": 3500,
  "test-user-frank-horvat": 2500,
  "test-user-greta-jones": 5500,
};

const buildRateTables = (): {
  tables: RateTableSeed[];
  entries: RateEntrySeed[];
} => {
  const tables: RateTableSeed[] = [];
  const entries: RateEntrySeed[] = [];
  for (let wsIndex = 0; wsIndex < seedWorkspaces.length; wsIndex++) {
    const ws = at(seedWorkspaces, wsIndex);
    const tableId = seedId(`rate-table-${wsIndex}`);
    tables.push({
      id: tableId,
      workspaceId: ws.id,
      name: "Default Rate Table",
      currency: "CZK",
    });
    for (let ui = 0; ui < ALL_USER_IDS.length; ui++) {
      const userId = at(ALL_USER_IDS, ui);
      entries.push({
        id: seedId(`rate-entry-${wsIndex}-${ui}`),
        workspaceId: ws.id,
        rateTableId: tableId,
        userId,
        hourlyRate: USER_RATES[userId] ?? 4000,
        effectiveFrom: "2024-01-01",
      });
    }
  }
  return { tables, entries };
};

// ─── Extended time entries (~500) ──────────────────────

const EXTENDED_NARRATIVES = [
  "Review of acquisition agreement draft",
  "Client conference call re: deal terms",
  "Legal research on regulatory compliance",
  "Preparation of due diligence checklist",
  "Analysis of opposing party's motion",
  "Drafting response to counterparty",
  "Review of financial disclosure documents",
  "Witness interview preparation",
  "Court filing and service coordination",
  "Negotiation of settlement terms",
  "Review of employment contract amendments",
  "Compliance risk assessment meeting",
  "Cross-border regulatory analysis",
  "GDPR gap analysis and documentation",
  "Internal team strategy discussion",
  "Preparation of expert witness report",
  "Review of corporate restructuring plan",
  "Analysis of environmental permit conditions",
  "Draft shareholder resolution",
  "Anti-money laundering review",
  "Review of merger notification filing",
  "Client update on litigation status",
  "Research on jurisdictional questions",
  "Preparation of closing documents",
  "Review of lease agreement modifications",
  "Correspondence with opposing counsel",
  "Due diligence on target company assets",
  "Review of intellectual property portfolio",
  "Preparation for arbitration hearing",
  "Analysis of insurance coverage terms",
  "Tax advisory on cross-border transaction",
  "Review of non-compete clause enforceability",
  "Preparation of board meeting minutes",
  "Research on data protection regulations",
  "Draft supply contract amendments",
  "Review of regulatory investigation response",
  "Client briefing on new legislation",
  "Analysis of construction contract claims",
  "Preparation of settlement proposal",
  "Review of export control compliance",
];

type ExtendedTimeEntrySeed = {
  id: string;
  workspaceId: string;
  userId: string;
  matterId: string;
  dateWorked: string;
  durationMinutes: number;
  billedMinutes: number;
  rateAtEntry: number;
  currency: string;
  narrative: string;
  billable: boolean;
  status: "draft" | "approved" | "billed" | "written_off";
  taskCode: string;
  activityCode: string;
  invoiceId: string | null;
};

const WS_LABELS = [
  "ws-akvizice-energo",
  "ws-stavebni-spor",
  "ws-due-diligence",
  "ws-pracovni-spory",
  "ws-compliance-ceska-energie",
  "ws-reorganizace",
  "ws-cross-border",
  "ws-gdpr-audit",
] as const;

const buildExtendedTimeEntries = (
  invoiceIds: string[],
): ExtendedTimeEntrySeed[] => {
  const entries: ExtendedTimeEntrySeed[] = [];
  const TARGET = 500;

  for (let i = 0; i < TARGET; i++) {
    const wsIndex = i % seedWorkspaces.length;
    const ws = at(seedWorkspaces, wsIndex);
    const wsLabel = at(WS_LABELS, wsIndex);
    const matterId = seedId(`${wsLabel}-doc-1`);
    const userIndex = i % ALL_USER_IDS.length;
    const userId = at(ALL_USER_IDS, userIndex);
    const rate = USER_RATES[userId] ?? 4000;

    // Spread across 90 days (Dec 2024 – Feb 2025)
    const dayOffset = i % 90;
    const date = new Date(2024, 11, 1 + dayOffset);
    const dateStr = date.toISOString().slice(0, 10);

    // Duration: 15–240 min, varied
    const duration = 15 + ((i * 7 + 13) % 226);
    const billedMinutes = Math.ceil(duration / 6) * 6;

    const narrative = at(EXTENDED_NARRATIVES, i % EXTENDED_NARRATIVES.length);
    const taskCode = at(TASK_CODES, i % TASK_CODES.length).code;
    const activityCode = at(ACTIVITY_CODES, i % ACTIVITY_CODES.length).code;

    // Status distribution: 60% draft, 25% approved,
    // 10% billed, 5% written_off
    const statusRoll = i % 20;
    let status: ExtendedTimeEntrySeed["status"] = "draft";
    let invoiceId: string | null = null;
    if (statusRoll >= 19) {
      status = "written_off";
    } else if (statusRoll >= 17) {
      status = "billed";
      invoiceId = at(invoiceIds, i % invoiceIds.length);
    } else if (statusRoll >= 12) {
      status = "approved";
    }

    const billable = i % 7 !== 0;

    entries.push({
      id: seedId(`ext-time-entry-${i}`),
      workspaceId: ws.id,
      userId,
      matterId,
      dateWorked: dateStr,
      durationMinutes: duration,
      billedMinutes,
      rateAtEntry: rate,
      currency: "CZK",
      narrative,
      billable,
      status,
      taskCode,
      activityCode,
      invoiceId,
    });
  }
  return entries;
};

// ─── Expenses (~50) ────────────────────────────────────

type ExpenseSeed = {
  id: string;
  workspaceId: string;
  userId: string;
  matterId: string;
  dateIncurred: string;
  amount: number;
  currency: string;
  category:
    | "filing_fee"
    | "expert_witness"
    | "travel"
    | "printing"
    | "courier"
    | "other";
  description: string;
  billable: boolean;
  status: "draft" | "approved" | "billed" | "written_off";
};

const EXPENSE_CATEGORIES = [
  "filing_fee",
  "travel",
  "expert_witness",
  "printing",
  "courier",
  "other",
] as const;

const EXPENSE_DESCRIPTIONS = [
  "Court filing fee",
  "Travel to client office",
  "Expert witness consultation fee",
  "Document printing and binding",
  "Courier delivery of signed contracts",
  "Notarization fee",
  "Land registry extract",
  "Process server fee",
  "Conference room rental",
  "Postage for certified mail",
];

const buildExpenses = (): ExpenseSeed[] => {
  const expenseSeeds: ExpenseSeed[] = [];
  const TARGET = 50;

  for (let i = 0; i < TARGET; i++) {
    const wsIndex = i % seedWorkspaces.length;
    const ws = at(seedWorkspaces, wsIndex);
    const wsLabel = at(WS_LABELS, wsIndex);
    const matterId = seedId(`${wsLabel}-doc-1`);
    const userId = pickAuthor(i);
    const dayOffset = (i * 3) % 90;
    const date = new Date(2024, 11, 1 + dayOffset);
    const dateStr = date.toISOString().slice(0, 10);

    // Amounts 500–50000 CZK
    const amount = 500 + ((i * 997) % 49_501);
    const category = at(EXPENSE_CATEGORIES, i % EXPENSE_CATEGORIES.length);
    const description = at(
      EXPENSE_DESCRIPTIONS,
      i % EXPENSE_DESCRIPTIONS.length,
    );
    const billable = i % 5 !== 0;
    const statusRoll = i % 10;
    let status: ExpenseSeed["status"] = "draft";
    if (statusRoll >= 9) {
      status = "written_off";
    } else if (statusRoll >= 7) {
      status = "billed";
    } else if (statusRoll >= 4) {
      status = "approved";
    }

    expenseSeeds.push({
      id: seedId(`expense-${i}`),
      workspaceId: ws.id,
      userId,
      matterId,
      dateIncurred: dateStr,
      amount,
      currency: "CZK",
      category,
      description,
      billable,
      status,
    });
  }
  return expenseSeeds;
};

// ─── Invoices (~5) ─────────────────────────────────────

type InvoiceSeed = {
  id: string;
  workspaceId: string;
  invoiceNumber: string;
  status: "draft" | "finalized" | "sent" | "paid";
  invoiceDate: string;
  dueDate: string;
  currency: string;
  totalAmount: number;
};

const buildInvoices = (): InvoiceSeed[] => {
  const invoiceStatuses = [
    "draft",
    "finalized",
    "sent",
    "paid",
    "sent",
  ] as const;
  const invoiceSeeds: InvoiceSeed[] = [];
  for (let i = 0; i < 5; i++) {
    const wsIndex = i % seedWorkspaces.length;
    const ws = at(seedWorkspaces, wsIndex);
    invoiceSeeds.push({
      id: seedId(`invoice-${i}`),
      workspaceId: ws.id,
      invoiceNumber: `INV-2025-${String(i + 1).padStart(4, "0")}`,
      status: at(invoiceStatuses, i),
      invoiceDate: `2025-0${i + 1}-15`,
      dueDate: `2025-0${i + 2}-15`,
      currency: "CZK",
      totalAmount: 50_000 + i * 25_000,
    });
  }
  return invoiceSeeds;
};

// ─── Additional workspaces for overview stress-testing ──

const MORE_WORKSPACES = [
  // Bratislava Legal Group
  {
    name: "Reštitučné konanie Bratislava",
    reference: "2024/009",
    clientLabel: "contact-org-bratislava-legal",
  },
  {
    name: "Obchodný spor – dodávky",
    reference: "2024/010",
    clientLabel: "contact-org-bratislava-legal",
  },
  {
    name: "Prevod obchodného podielu",
    reference: "2024/011",
    clientLabel: "contact-org-bratislava-legal",
  },
  // Müller & Bergmann
  {
    name: "Kartellrechtliche Prüfung",
    reference: "2024/012",
    clientLabel: "contact-org-muller-bergmann",
  },
  {
    name: "Gesellschafterstreit GmbH",
    reference: "2024/013",
    clientLabel: "contact-org-muller-bergmann",
  },
  {
    name: "Arbeitsrechtliche Restrukturierung",
    reference: "2024/014",
    clientLabel: "contact-org-muller-bergmann",
  },
  {
    name: "Datenschutz-Folgenabschätzung",
    reference: "2024/015",
    clientLabel: "contact-org-muller-bergmann",
  },
  // Thames Advisory
  {
    name: "Shareholder Dispute Resolution",
    reference: "2024/016",
    clientLabel: "contact-org-thames-advisory",
  },
  {
    name: "UK Regulatory Filing",
    reference: "2024/017",
    clientLabel: "contact-org-thames-advisory",
  },
  {
    name: "Post-Acquisition Integration",
    reference: "2024/018",
    clientLabel: "contact-org-thames-advisory",
  },
  {
    name: "Employee Share Scheme",
    reference: "2024/019",
    clientLabel: "contact-org-thames-advisory",
  },
  {
    name: "Anti-Bribery Compliance Review",
    reference: "2024/020",
    clientLabel: "contact-org-thames-advisory",
  },
  // Žilina Steel
  {
    name: "Environmentálne povolenia",
    reference: "2024/021",
    clientLabel: "contact-org-zilina-steel",
  },
  {
    name: "Kolektívna zmluva 2025",
    reference: "2024/022",
    clientLabel: "contact-org-zilina-steel",
  },
  {
    name: "Cezhraničná dodávka ocele",
    reference: "2024/023",
    clientLabel: "contact-org-zilina-steel",
  },
  // PragoBanka
  {
    name: "Syndikovaný úvěr – strukturace",
    reference: "2024/024",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "Regulatorní reporting ČNB",
    reference: "2024/025",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "AML vyšetřování",
    reference: "2024/026",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "Spotřebitelské úvěry – audit",
    reference: "2024/027",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "Bankovní záruky – rámcová smlouva",
    reference: "2024/028",
    clientLabel: "contact-org-pragobanka",
  },
  {
    name: "Digitální transformace – právní rámec",
    reference: "2024/029",
    clientLabel: "contact-org-pragobanka",
  },
  // Dunaj Pharma
  {
    name: "Registrácia liečiv ŠÚKL",
    reference: "2024/030",
    clientLabel: "contact-org-dunaj-pharma",
  },
  {
    name: "Klinické skúšanie – zmluvy",
    reference: "2024/031",
    clientLabel: "contact-org-dunaj-pharma",
  },
  {
    name: "Patentový spor – generikum",
    reference: "2024/032",
    clientLabel: "contact-org-dunaj-pharma",
  },
  {
    name: "Distribučná sieť – regulácia",
    reference: "2024/033",
    clientLabel: "contact-org-dunaj-pharma",
  },
  // Nord Energie
  {
    name: "Windpark Genehmigung Nordsee",
    reference: "2024/034",
    clientLabel: "contact-org-nord-energie",
  },
  {
    name: "Energieliefervertrag B2B",
    reference: "2024/035",
    clientLabel: "contact-org-nord-energie",
  },
  {
    name: "Netzanschluss Offshore",
    reference: "2024/036",
    clientLabel: "contact-org-nord-energie",
  },
  {
    name: "EEG-Umlage Optimierung",
    reference: "2024/037",
    clientLabel: "contact-org-nord-energie",
  },
  {
    name: "Gasliefervertrag Russland-Exit",
    reference: "2024/038",
    clientLabel: "contact-org-nord-energie",
  },
  // Ostrava Mining
  {
    name: "Těžební licence – prodloužení",
    reference: "2024/039",
    clientLabel: "contact-org-ostrava-mining",
  },
  {
    name: "Rekultivace území Karviná",
    reference: "2024/040",
    clientLabel: "contact-org-ostrava-mining",
  },
  {
    name: "Pracovní úrazy – hromadná žaloba",
    reference: "2024/041",
    clientLabel: "contact-org-ostrava-mining",
  },
  {
    name: "Emise CO₂ – povolenky EU ETS",
    reference: "2024/042",
    clientLabel: "contact-org-ostrava-mining",
  },
  // Crown Shipping
  {
    name: "Charter Party Dispute",
    reference: "2024/043",
    clientLabel: "contact-org-crown-shipping",
  },
  {
    name: "Marine Insurance Claim",
    reference: "2024/044",
    clientLabel: "contact-org-crown-shipping",
  },
  {
    name: "Port Authority Compliance",
    reference: "2024/045",
    clientLabel: "contact-org-crown-shipping",
  },
  {
    name: "Sanctions Screening Programme",
    reference: "2024/046",
    clientLabel: "contact-org-crown-shipping",
  },
  {
    name: "Bill of Lading Fraud Investigation",
    reference: "2024/047",
    clientLabel: "contact-org-crown-shipping",
  },
  // Tatra Motors
  {
    name: "Homologace vozidla EU",
    reference: "2024/048",
    clientLabel: "contact-org-tatra-motors",
  },
  {
    name: "Záruční spor – flotila",
    reference: "2024/049",
    clientLabel: "contact-org-tatra-motors",
  },
  {
    name: "Dodavatelský řetězec – audit",
    reference: "2024/050",
    clientLabel: "contact-org-tatra-motors",
  },
  {
    name: "Ochranná známka TATRA",
    reference: "2024/051",
    clientLabel: "contact-org-tatra-motors",
  },
  // Košice Tech Ventures
  {
    name: "Seed investment – term sheet",
    reference: "2024/052",
    clientLabel: "contact-org-kosice-tech",
  },
  {
    name: "IP licenčná zmluva",
    reference: "2024/053",
    clientLabel: "contact-org-kosice-tech",
  },
  {
    name: "ESOP program pre zamestnancov",
    reference: "2024/054",
    clientLabel: "contact-org-kosice-tech",
  },
  // Extra matters for existing clients (deeper grouping)
  {
    name: "Daňová optimalizace holdingu",
    reference: "2024/055",
    clientLabel: "contact-org-novak-partners",
  },
  {
    name: "Obchodní registr – změny",
    reference: "2024/056",
    clientLabel: "contact-org-ceska-energie",
  },
  {
    name: "Stavební povolení Brno-jih",
    reference: "2024/057",
    clientLabel: "contact-org-moravska-stavebni",
  },
  {
    name: "Fund IV Structuring",
    reference: "2024/058",
    clientLabel: "contact-org-greenleaf",
  },
];

// ─── Main ───────────────────────────────────────────────

export async function seed(organizationId?: string, userId?: string) {
  const ORG_ID = toSafeId<"organization">(organizationId ?? DEFAULT_ORG_ID);
  const USER_ID = userId ?? DEFAULT_USER_ID;
  const toWs = (id: string) => toSafeId<"workspace">(id);

  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run in production.");
  }

  // Ensure all test users + memberships exist so entity
  // FK constraints on created_by are satisfied.
  await ensureTestUsers(ORG_ID);

  console.log("Seeding development data...\n");

  // 1. Contacts (original orgs + people)
  const coreContacts = [...orgContacts, ...personContacts];
  for (const c of coreContacts) {
    await db
      .insert(contacts)
      .values({
        id: c.id,
        organizationId: ORG_ID,
        type: c.type,
        displayName: c.displayName,
        prefix: "prefix" in c ? c.prefix : undefined,
        firstName: "firstName" in c ? c.firstName : undefined,
        lastName: "lastName" in c ? c.lastName : undefined,
        suffix: "suffix" in c ? c.suffix : undefined,
        organizationName:
          "organizationName" in c ? c.organizationName : undefined,
        notes: "notes" in c ? c.notes : undefined,
        emails: "emails" in c ? c.emails : undefined,
        phones: "phones" in c ? c.phones : undefined,
        color: c.color,
        registrationNumber:
          "registrationNumber" in c ? c.registrationNumber : undefined,
        taxId: "taxId" in c ? c.taxId : undefined,
        bankAccounts: "bankAccounts" in c ? c.bankAccounts : undefined,
        billingAddress: "billingAddress" in c ? c.billingAddress : undefined,
        defaultHourlyRate:
          "defaultHourlyRate" in c ? c.defaultHourlyRate : undefined,
        currency: "currency" in c ? c.currency : undefined,
        paymentTermDays: "paymentTermDays" in c ? c.paymentTermDays : undefined,
        originatingAttorneyId: USER_ID,
        responsibleAttorneyId: USER_ID,
        createdBy: USER_ID,
      })
      .onConflictDoNothing();
  }
  // 1b. Additional org contacts for overview stress-testing
  for (const c of moreOrgContacts) {
    await db
      .insert(contacts)
      .values({
        id: c.id,
        organizationId: ORG_ID,
        type: c.type,
        displayName: c.displayName,
        organizationName: c.organizationName,
        registrationNumber: c.registrationNumber,
        taxId: c.taxId,
        billingAddress: c.billingAddress,
        defaultHourlyRate: c.defaultHourlyRate,
        currency: c.currency,
        paymentTermDays: c.paymentTermDays,
        emails: c.emails,
        color: c.color,
        originatingAttorneyId: USER_ID,
        responsibleAttorneyId: USER_ID,
        createdBy: USER_ID,
      })
      .onConflictDoNothing();
  }
  const totalContacts = coreContacts.length + moreOrgContacts.length;
  console.log(
    `  Contacts: ${totalContacts} (${orgContacts.length + moreOrgContacts.length} orgs, ${personContacts.length} people)`,
  );

  // 2. Workspaces
  for (const ws of seedWorkspaces) {
    await db
      .insert(workspaces)
      .values({
        id: ws.id,
        organizationId: ORG_ID,
        name: ws.name,
        reference: ws.reference,
        clientId: ws.clientId,
        billingReference:
          "billingReference" in ws ? ws.billingReference : undefined,
      })
      .onConflictDoNothing();
  }
  // 2b. Additional workspaces (overview stress-testing)
  let moreWsCount = 0;
  for (const mw of MORE_WORKSPACES) {
    const clientId = seedId(mw.clientLabel);
    const wsId = seedId(`extra-ws-${mw.reference}`);
    await db
      .insert(workspaces)
      .values({
        id: wsId,
        organizationId: ORG_ID,
        name: mw.name,
        reference: mw.reference,
        clientId,
      })
      .onConflictDoNothing();

    moreWsCount++;
  }
  console.log(
    `  Workspaces: ${seedWorkspaces.length} + ${moreWsCount} extra = ${seedWorkspaces.length + moreWsCount}`,
  );

  // 3. Properties
  const allProperties: PropertySeed[] = [];
  const wsLabels = [
    "ws-akvizice-energo",
    "ws-stavebni-spor",
    "ws-due-diligence",
    "ws-pracovni-spory",
    "ws-compliance-ceska-energie",
    "ws-reorganizace",
    "ws-cross-border",
    "ws-gdpr-audit",
  ];
  for (let i = 0; i < seedWorkspaces.length; i++) {
    allProperties.push(
      ...buildProperties(at(seedWorkspaces, i).id, at(wsLabels, i)),
    );
  }
  for (const mw of MORE_WORKSPACES) {
    const wsId = seedId(`extra-ws-${mw.reference}`);
    const label = `extra-ws-${mw.reference}`;
    allProperties.push(...buildProperties(wsId, label));
  }
  for (const prop of allProperties) {
    await db
      .insert(properties)
      .values({
        id: prop.id,
        workspaceId: toWs(prop.workspaceId),
        name: prop.name,
        content: prop.content,
        tool: prop.tool,
        ...(prop.system !== undefined && { system: prop.system }),
        ...(prop.kinds !== undefined && { kinds: prop.kinds }),
      })
      .onConflictDoNothing();
  }
  console.log(
    `  Properties: ${allProperties.length} (${allProperties.length / seedWorkspaces.length}/workspace)`,
  );

  // 4. Entities + entity versions
  const allEntities: EntitySeed[] = [];
  for (let i = 0; i < seedWorkspaces.length; i++) {
    allEntities.push(
      ...buildEntities(at(seedWorkspaces, i).id, at(wsLabels, i)),
    );
  }
  // Also create entities in extra workspaces, cycling through
  // the 8 document-name sets so every workspace has docs.
  for (let i = 0; i < MORE_WORKSPACES.length; i++) {
    const mw = at(MORE_WORKSPACES, i);
    const wsId = seedId(`extra-ws-${mw.reference}`);
    const label = `extra-ws-${mw.reference}`;
    allEntities.push(...buildEntities(wsId, label));
  }
  for (let ei = 0; ei < allEntities.length; ei++) {
    const e = allEntities[ei];
    await db
      .insert(entities)
      .values({
        id: e.entityId,
        workspaceId: toWs(e.workspaceId),
        kind: e.kind,
        parentId: e.parentId,
        createdBy: pickAuthor(ei),
      })
      .onConflictDoNothing();

    await db
      .insert(entityVersions)
      .values({
        id: e.versionId,
        workspaceId: toWs(e.workspaceId),
        entityId: e.entityId,
      })
      .onConflictDoNothing();

    // Link currentVersionId
    await db
      .update(entities)
      .set({ currentVersionId: e.versionId })
      .where((await import("drizzle-orm")).eq(entities.id, e.entityId));
  }
  console.log(
    `  Entities: ${allEntities.length} (${allEntities.length / seedWorkspaces.length}/workspace)`,
  );

  // 6. Document content: files (S3), file fields, extracted
  //    text, status/metadata fields, and search index.
  //
  //    Content is defined ONCE in `documentTexts` and flows to:
  //      - PDF/DOCX file on S3 (preview)
  //      - `extracted_content` table (AI readContent tool)
  //      - `search_documents` table (AI searchMatter tool)
  //      - `fields` table (file field + status/date/notes)
  const IV_BYTES = 12;
  let fileCount = 0;
  let pdfTwinCount = 0;
  let extractedCount = 0;

  const allDocNames = Object.values(workspaceDocNames).flat();

  /** Seed all document content for a single workspace. */
  const seedDocumentsForWorkspace = async (
    wsId: string,
    wsLabel: string,
    docNames: string[],
  ) => {
    const filePropertyId = seedId(`${wsLabel}-prop-file`);
    const docEntities = allEntities.filter(
      (e) => e.workspaceId === wsId && e.kind === "document",
    );

    for (let j = 0; j < docEntities.length; j++) {
      const entity = at(docEntities, j);
      const fileName = at(docNames, j);
      const isDocx = fileName.endsWith(".docx");
      const mimeType = isDocx ? DOCX_MIME : PDF_MIME;
      const ext = isDocx ? "docx" : "pdf";

      const title = fileName.replace(fileExtRe, "").replaceAll("_", " ");

      // Single source of truth for document content
      const docText = documentTexts[fileName];

      // ── S3 file ──
      const content = isDocx
        ? await createMockDocx(title, docText)
        : createMockPdf(title, docText);

      const sha256Hex = new Bun.CryptoHasher("sha256")
        .update(content)
        .digest("hex");

      const fileId = seedId(`${wsLabel}-file-${j}`);
      const s3Key = `${ORG_ID}/${wsId}/${fileId}.${ext}`;
      await s3.write(s3Key, new Uint8Array(content));

      // DOCX → PDF converted twin
      let pdfFileId: string | null = null;
      if (isDocx) {
        pdfFileId = seedId(`${wsLabel}-pdf-twin-${j}`);
        const pdfContent = createMockPdf(title, docText);
        const pdfS3Key = `${ORG_ID}/${wsId}/${pdfFileId}.pdf`;
        await s3.write(pdfS3Key, new Uint8Array(pdfContent));
        pdfTwinCount++;
      }

      // ── File field ──
      await db
        .insert(fields)
        .values({
          id: seedId(`${wsLabel}-field-file-${j}`),
          workspaceId: toWs(entity.workspaceId),
          propertyId: filePropertyId,
          entityVersionId: entity.versionId,
          content: {
            version: 1,
            type: "file",
            id: fileId,
            fileName,
            mimeType,
            sizeBytes: content.length,
            encrypted: false,
            sha256Hex,
            pdfFileId,
          },
        })
        .onConflictDoNothing();
      fileCount++;

      // ── Extracted content (AI reads this) ──
      // Resolve the org from the workspace row so this
      // matches the org the user's session will filter by
      // (workspaces may belong to an org created before
      // the seed ran, e.g. via manual signup).
      if (docText) {
        const ws = await db.query.workspaces.findFirst({
          where: { id: toWs(wsId) },
          columns: { organizationId: true },
        });
        const ecOrgId = ws?.organizationId ?? ORG_ID;

        await db
          .insert(extractedContent)
          .values({
            entityId: entity.entityId,
            organizationId: ecOrgId,
            workspaceId: toWs(entity.workspaceId),
            ciphertext: Buffer.from(docText, "utf8"),
            iv: Buffer.alloc(IV_BYTES),
            charCount: docText.length,
            language: null,
            extractedAt: new Date(),
          })
          .onConflictDoNothing();
        extractedCount++;
      }
    }
  };

  // Resolve doc names for each workspace
  type WsDocPlan = {
    wsId: string;
    wsLabel: string;
    docNames: string[];
  };
  const docPlans: WsDocPlan[] = [];

  // Main 8 workspaces
  for (let i = 0; i < seedWorkspaces.length; i++) {
    const ws = at(seedWorkspaces, i);
    const wsLabel = at(wsLabels, i);
    const docNames = workspaceDocNames[wsLabel];
    if (docNames) {
      docPlans.push({ wsId: ws.id, wsLabel, docNames });
    }
  }

  // Extra workspaces: pseudo-random doc set
  for (let i = 0; i < MORE_WORKSPACES.length; i++) {
    const mw = at(MORE_WORKSPACES, i);
    const wsId = seedId(`extra-ws-${mw.reference}`);
    const wsLabel = `extra-ws-${mw.reference}`;
    const hash = seedId(`${wsLabel}-docs`).codePointAt(0) ?? 0;
    const picked: string[] = [];
    for (let d = 0; d < 4; d++) {
      const idx = (hash + d * 7) % allDocNames.length;
      picked.push(at(allDocNames, idx));
    }
    docPlans.push({ wsId, wsLabel, docNames: picked });
  }

  for (const plan of docPlans) {
    await seedDocumentsForWorkspace(plan.wsId, plan.wsLabel, plan.docNames);
  }

  console.log(
    `  Files: ${fileCount} (uploaded to S3, ${pdfTwinCount} PDF twins)`,
  );
  console.log(`  Extracted content: ${extractedCount} documents`);

  // 7. Fields (status, due date, notes for each document)
  const allFields: FieldSeed[] = [];
  for (const plan of docPlans) {
    const wsEntities = allEntities.filter((e) => e.workspaceId === plan.wsId);
    allFields.push(...buildFields(plan.wsLabel, wsEntities));
  }
  for (const f of allFields) {
    await db
      .insert(fields)
      .values({
        id: f.id,
        workspaceId: toWs(f.workspaceId),
        propertyId: f.propertyId,
        entityVersionId: f.entityVersionId,
        content: f.content,
      })
      .onConflictDoNothing();
  }
  console.log(`  Fields: ${allFields.length}`);

  // 7b. Ensure tsv column exists (not in Drizzle schema)
  await db.execute(sql`
    ALTER TABLE search_documents
      ADD COLUMN IF NOT EXISTS tsv tsvector
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS search_documents_tsv_idx
      ON search_documents USING gin (tsv)
  `);

  // 7c. Search index (depends on fields + extracted content)
  let searchCount = 0;
  for (const e of allEntities) {
    await upsertSearchDocument(e.entityId);
    searchCount++;
  }
  console.log(`  Search index: ${searchCount} documents`);

  // 8. Workspace contacts (parties)
  for (const party of seedParties) {
    await db
      .insert(workspaceContacts)
      .values({
        id: party.id,
        organizationId: ORG_ID,
        workspaceId: toWs(party.workspaceId),
        contactId: party.contactId,
        role: party.role,
      })
      .onConflictDoNothing();
  }
  console.log(`  Parties: ${seedParties.length}`);

  // 9. Billing codes
  const billingCodeSeeds = buildBillingCodes();
  for (const bc of billingCodeSeeds) {
    await db
      .insert(billingCodes)
      .values({
        id: bc.id,
        organizationId: ORG_ID,
        workspaceId: toWs(bc.workspaceId),
        type: bc.type,
        code: bc.code,
        label: bc.label,
        sortOrder: bc.sortOrder,
      })
      .onConflictDoNothing();
  }
  console.log(`  Billing codes: ${billingCodeSeeds.length}`);

  // 10. Rate tables + entries
  const { tables: rateTableSeeds, entries: rateEntrySeeds } = buildRateTables();
  for (const rt of rateTableSeeds) {
    await db
      .insert(rateTables)
      .values({
        id: rt.id,
        organizationId: ORG_ID,
        workspaceId: toWs(rt.workspaceId),
        name: rt.name,
        currency: rt.currency,
        isDefault: true,
      })
      .onConflictDoNothing();
  }
  for (const re of rateEntrySeeds) {
    await db
      .insert(rateEntries)
      .values({
        id: re.id,
        workspaceId: toWs(re.workspaceId),
        rateTableId: re.rateTableId,
        userId: re.userId,
        hourlyRate: re.hourlyRate,
        effectiveFrom: re.effectiveFrom,
      })
      .onConflictDoNothing();
  }
  console.log(
    `  Rate tables: ${rateTableSeeds.length}, entries: ${rateEntrySeeds.length}`,
  );

  // 11. Invoices (must be inserted before time entries
  // that reference them)
  const invoiceSeeds = buildInvoices();
  for (const inv of invoiceSeeds) {
    await db
      .insert(invoices)
      .values({
        id: inv.id,
        organizationId: ORG_ID,
        workspaceId: toWs(inv.workspaceId),
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        invoiceDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        currency: inv.currency,
        totalAmount: inv.totalAmount,
      })
      .onConflictDoNothing();
  }
  console.log(`  Invoices: ${invoiceSeeds.length}`);

  // 12. Extended time entries (~500)
  const invoiceIds = invoiceSeeds.map((inv) => inv.id);
  const extTimeEntries = buildExtendedTimeEntries(invoiceIds);
  for (const te of extTimeEntries) {
    await db
      .insert(timeEntries)
      .values({
        id: te.id,
        organizationId: ORG_ID,
        workspaceId: toWs(te.workspaceId),
        userId: te.userId,
        matterId: te.matterId,
        dateWorked: te.dateWorked,
        timezoneId: "Europe/Prague",
        durationMinutes: te.durationMinutes,
        billedMinutes: te.billedMinutes,
        rateAtEntry: te.rateAtEntry,
        currency: te.currency,
        narrative: te.narrative,
        billable: te.billable,
        status: te.status,
        taskCode: te.taskCode,
        activityCode: te.activityCode,
        invoiceId: te.invoiceId,
      })
      .onConflictDoNothing();
  }
  console.log(`  Time entries: ${extTimeEntries.length}`);

  // 13. Expenses (~50)
  const expenseSeeds = buildExpenses();
  for (const exp of expenseSeeds) {
    await db
      .insert(expenses)
      .values({
        id: exp.id,
        organizationId: ORG_ID,
        workspaceId: toWs(exp.workspaceId),
        userId: exp.userId,
        matterId: exp.matterId,
        dateIncurred: exp.dateIncurred,
        amount: exp.amount,
        currency: exp.currency,
        category: exp.category,
        description: exp.description,
        billable: exp.billable,
        status: exp.status,
      })
      .onConflictDoNothing();
  }
  console.log(`  Expenses: ${expenseSeeds.length}`);

  // 14. Templates & clauses (knowledge base)
  await seedTemplates(ORG_ID);

  console.log("\nDone. Dev data seeded successfully.");
}

// Allow running as a CLI script
if (import.meta.main) {
  // Verify test user exists when running standalone
  const testUser = await db.query.user.findFirst({
    where: { id: DEFAULT_USER_ID },
    columns: { id: true },
  });
  if (!testUser) {
    console.error(
      "Test user not found. Run `bun run db:seed-test-user` first.",
    );
    process.exit(1);
  }

  seed()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
