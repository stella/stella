// The English development firm, Harbrook & Partners: an English-speaking
// cast whose matters include Czech and Slovak work, so several documents are
// in those languages. The marketing captures film it as the English set.
import exposureView from "@/api/handlers/visual-sandbox/fixtures/showcase/change-of-control-exposure.json";

import { at, getSeedColleagues, seedId } from "../seed-utils";
import {
  supplierAgreementBody as body,
  supplierAgreementHeading as heading,
} from "./types";
import type {
  SeedEmail,
  SeedLocaleContent,
  StandardMatterLabel,
  SupplierAgreementParagraph,
} from "./types";

// English filename over a Czech-language body: the workspace stills film this
// file list, and the marketing cast files documents in English; the body stays
// Czech (like Due_Diligence_Report.pdf) so the Czech playbook demo keeps a
// Czech-law SPA to review.
const SPA_DOCUMENT_NAME = "Share_Acquisition_Agreement.pdf";

const SUPPLIER_AGREEMENT_FILE_NAME = "Supplier_Agreement.docx";

// Reviewer identity stamped on the tracked changes and margin comments;
// Clara Novak is a seeded colleague (clara@stella.dev).
const SUPPLIER_AGREEMENT_REVIEWER = {
  author: "Clara Novak",
  date: "2026-07-16T09:30:00Z",
  initials: "CN",
};

const SUPPLIER_AGREEMENT_COMMENTS = [
  {
    id: 1,
    text:
      "Above the approved liability cap: the Procurement Playbook allows at " +
      "most 100% of annual fees. Redlined to the playbook position; needs " +
      "Legal sign-off.",
  },
  {
    id: 2,
    text:
      "Playbook requires at least ninety (90) days' termination notice for " +
      "supply-critical agreements. Second deviation flagged for Legal " +
      "review.",
  },
];

const SUPPLIER_AGREEMENT_PARAGRAPHS: readonly SupplierAgreementParagraph[] = [
  { runs: [{ kind: "text", text: "Supplier Agreement" }], style: "title" },
  body("NEGOTIATION DRAFT v4 — CONTAINS TRACKED CHANGES"),
  body(
    "This Supplier Agreement (the “Agreement”) is entered into as of 1 July " +
      "2026 (the “Effective Date”) by and between:",
  ),
  body(
    "(1) Northstar Robotics, Inc., a Delaware corporation with offices at " +
      "548 Market Street, San Francisco, California 94104, United States " +
      "(the “Customer”); and",
  ),
  body(
    "(2) Meridian Precision Components GmbH, a company organised under the " +
      "laws of Germany with registered offices at Werkstrasse 12, 80339 " +
      "Munich, Germany (the “Supplier”),",
  ),
  body("each a “Party” and together the “Parties”."),
  body(
    "WHEREAS the Customer designs and manufactures autonomous mobile robots " +
      "and requires a reliable supply of precision drive components; and " +
      "WHEREAS the Supplier manufactures harmonic drive gears, actuator " +
      "housings and related components meeting the Specifications; NOW, " +
      "THEREFORE, the Parties agree as follows.",
  ),
  heading("1. Definitions and interpretation"),
  body(
    "1.1 In this Agreement: “Affiliate” means any entity that directly or " +
      "indirectly controls, is controlled by, or is under common control " +
      "with a Party; “Annual Fees” means the aggregate fees paid or payable " +
      "by the Customer under this Agreement during the twelve (12) months " +
      "immediately preceding the event giving rise to the relevant claim; " +
      "“Business Day” means a day other than a Saturday, Sunday or public " +
      "holiday in San Francisco or Munich; “Order” means a purchase order " +
      "issued by the Customer under Clause 3; “Products” means the " +
      "components listed in Annex 1; and “Specifications” means the " +
      "technical specifications set out in Annex 1, as amended in " +
      "accordance with Clause 2.3.",
  ),
  body(
    "1.2 Headings are for convenience only and do not affect " +
      "interpretation. References to Clauses and Annexes are to the clauses " +
      "of, and annexes to, this Agreement.",
  ),
  heading("2. Supply of products"),
  body(
    "2.1 The Supplier shall manufacture and supply the Products in " +
      "accordance with the Specifications, the agreed quality standards and " +
      "the terms of this Agreement.",
  ),
  body(
    "2.2 The Supplier shall maintain sufficient production capacity to " +
      "satisfy the Customer's rolling forecast, up to one hundred and " +
      "twenty per cent (120%) of the most recent quarterly forecast volume.",
  ),
  body(
    "2.3 Neither Party may change the Specifications without the prior " +
      "written approval of the other Party. The Supplier shall give the " +
      "Customer at least twelve (12) months' written notice before " +
      "discontinuing any Product.",
  ),
  heading("3. Forecasts and orders"),
  body(
    "3.1 The Customer shall provide a rolling twelve (12) month forecast, " +
      "updated monthly. The first three (3) months of each forecast are " +
      "binding on the Customer.",
  ),
  body(
    "3.2 The Customer shall order Products by issuing an Order stating " +
      "quantities, delivery dates and delivery locations. The Supplier " +
      "shall accept or reject an Order within five (5) Business Days; an " +
      "Order not rejected within that period is deemed accepted.",
  ),
  body(
    "3.3 The Customer may cancel or reschedule an accepted Order more than " +
      "sixty (60) days before the scheduled delivery date at no charge.",
  ),
  heading("4. Delivery, title and risk"),
  body(
    "4.1 The Supplier shall deliver the Products DAP (Incoterms 2020) to " +
      "the Customer's facility identified in the Order. Delivery dates are " +
      "of the essence.",
  ),
  body(
    "4.2 If the Supplier fails to deliver by the confirmed delivery date, " +
      "the Customer is entitled to a delay credit of 0.5% of the Order " +
      "value per commenced week of delay, up to 5% of the Order value.",
  ),
  body(
    "4.3 Title to and risk in the Products pass to the Customer on " +
      "completed delivery under Clause 4.1.",
  ),
  heading("5. Prices and payment"),
  body(
    "5.1 Prices are set out in Annex 2 and are fixed until 31 December " +
      "2026. Price changes thereafter require ninety (90) days' written " +
      "notice and the Customer's written agreement.",
  ),
  body(
    "5.2 The Supplier shall invoice monthly in arrears. Undisputed invoices " +
      "are payable within forty-five (45) days of receipt of a correct " +
      "invoice.",
  ),
  body(
    "5.3 The Parties shall review prices annually in good faith, targeting " +
      "a productivity improvement of two per cent (2%) per year.",
  ),
  heading("6. Quality, inspection and non-conforming products"),
  body(
    "6.1 The Supplier shall maintain a quality management system certified " +
      "to ISO 9001 (or equivalent) and shall retain quality records for " +
      "each Product lot for at least ten (10) years.",
  ),
  body(
    "6.2 The Customer may perform incoming inspection within ten (10) " +
      "Business Days of delivery. Rejection of non-conforming Products " +
      "within that period does not limit the Customer's warranty rights.",
  ),
  body(
    "6.3 For non-conforming Products the Supplier shall, at the Customer's " +
      "election, replace the Products or refund the price, in each case " +
      "within ten (10) Business Days of notice.",
  ),
  heading("7. Warranties"),
  body(
    "7.1 The Supplier warrants that for twenty-four (24) months from " +
      "delivery each Product conforms to the Specifications, is free from " +
      "defects in materials and workmanship, and complies with applicable " +
      "law.",
  ),
  body(
    "7.2 The remedies in Clause 6.3 apply to any breach of the warranty in " +
      "Clause 7.1, without prejudice to the Customer's other rights under " +
      "this Agreement.",
  ),
  heading("8. Intellectual property"),
  body(
    "8.1 Each Party retains all rights in its background intellectual " +
      "property. Tooling, designs and Specifications provided by the " +
      "Customer remain the Customer's property and may be used by the " +
      "Supplier solely to perform this Agreement.",
  ),
  heading("9. Confidentiality"),
  body(
    "9.1 Each Party shall keep the other Party's confidential information " +
      "secret, use it solely to perform this Agreement, and disclose it " +
      "only to personnel and advisers who need it and are bound by " +
      "equivalent obligations. This Clause survives for five (5) years " +
      "after termination.",
  ),
  heading("10. Data protection and security"),
  body(
    "10.1 Each Party shall comply with applicable data protection law in " +
      "connection with this Agreement and shall implement appropriate " +
      "technical and organisational measures to protect personal data it " +
      "processes for the other Party.",
  ),
  heading("11. Insurance"),
  body(
    "11.1 The Supplier shall maintain product liability insurance of at " +
      "least EUR 5,000,000 per occurrence with a reputable insurer and " +
      "shall provide certificates of insurance on request.",
  ),
  heading("12. Limitation of liability"),
  body(
    "12.1 Nothing in this Agreement excludes or limits either Party's " +
      "liability for death or personal injury caused by negligence, for " +
      "fraud or fraudulent misrepresentation, or for any other liability " +
      "that may not be excluded or limited as a matter of law. Each party " +
      "remains responsible for its obligations under this Agreement.",
  ),
  {
    commentId: 1,
    runs: [
      {
        kind: "text",
        text: "12.2 The Supplier’s aggregate liability shall not exceed ",
      },
      { kind: "deleted", text: "300% of the fees" },
      { kind: "inserted", text: "100% of the annual fees" },
      { kind: "text", text: " paid under this Agreement." },
    ],
    style: "body",
  },
  body(
    "12.3 Neither Party is liable for loss of profits, loss of revenue, " +
      "loss of data, or any indirect or consequential loss, however " +
      "arising.",
  ),
  body(
    "12.4 The exclusions in this section survive termination of the Agreement.",
  ),
  heading("13. Indemnities"),
  body(
    "13.1 The Supplier shall indemnify the Customer against third-party " +
      "claims that a Product as delivered infringes intellectual property " +
      "rights, provided the Customer notifies the Supplier promptly and " +
      "gives the Supplier control of the defence.",
  ),
  heading("14. Term and termination"),
  {
    commentId: 2,
    runs: [
      {
        kind: "text",
        text:
          "14.1 This Agreement starts on the Effective Date and continues " +
          "for an initial term of three (3) years, renewing automatically " +
          "for successive one (1) year periods. Either Party may terminate " +
          "this Agreement for convenience by giving the other Party thirty " +
          "(30) days' prior written notice.",
      },
    ],
    style: "body",
  },
  body(
    "14.2 Either Party may terminate this Agreement with immediate effect " +
      "by written notice if the other Party undergoes a change of control " +
      "without the terminating Party's prior written approval, becomes " +
      "insolvent, or commits a material breach that remains uncured thirty " +
      "(30) days after written notice of the breach.",
  ),
  body(
    "14.3 Termination does not affect accrued rights. On termination the " +
      "Supplier shall return the Customer's tooling, designs and " +
      "confidential information, and shall support an orderly transition " +
      "of supply for up to six (6) months.",
  ),
  heading("15. Force majeure"),
  body(
    "15.1 Neither Party is liable for delay or failure to perform caused " +
      "by events beyond its reasonable control, provided it notifies the " +
      "other Party without undue delay and uses reasonable efforts to " +
      "mitigate. If a force majeure event continues for more than sixty " +
      "(60) days, either Party may terminate affected Orders.",
  ),
  heading("16. General"),
  body(
    "16.1 This Agreement is governed by the laws of England and Wales, and " +
      "the courts of London have exclusive jurisdiction.",
  ),
  body(
    "16.2 This Agreement, including its Annexes, is the entire agreement " +
      "between the Parties regarding its subject matter. Amendments must " +
      "be in writing and signed by both Parties. Notices must be in " +
      "writing to the addresses above.",
  ),
  body("SIGNED for and on behalf of NORTHSTAR ROBOTICS, INC."),
  body("Elena Park, Chief Executive Officer"),
  body("SIGNED for and on behalf of MERIDIAN PRECISION COMPONENTS GMBH"),
  body("Katrin Vogel, Managing Director"),
];

export const SEED_EMAIL_FILE_NAMES = [
  "Closing_tomorrow_final_checklist.eml",
  "Fwd_ERU_clearance_condition_7.eml",
  "Client_update_Praha.eml",
] as const;

type SeedEmailFileName = (typeof SEED_EMAIL_FILE_NAMES)[number];

const SEED_EMAILS = {
  "Closing_tomorrow_final_checklist.eml": {
    from: "Elena Park <elena.park@northstar.example>",
    to: [
      "Marcus Chen <marcus.chen@northstarseed.example>",
      "Katrin Vogel <katrin.vogel@meridian.example>",
    ],
    cc: [
      "Clara Novak <clara.novak@counsel.example>",
      "Closing Team <closing@northstar.example>",
    ],
    date: "Thu, 16 Jul 2026 17:42:00 +0200",
    subject: "Closing tomorrow: final checklist and funds flow",
    textBody: `Hi all,

We are ready to sign tomorrow at 09:00 CET. Please treat the attached funds flow as final unless Clara circulates a replacement before 08:30.

The EUR 2,500,000 escrow amount must not be released until both signature pages and the condition 7 waiver are confirmed in writing.

Final actions:
1. Katrin: return the signed supplier consent by 08:15.
2. Marcus: confirm the originating account ending 2048.
3. Clara: release the completion email after checking all signatures.

If anything changes overnight, reply to this thread rather than starting a new one.

Elena`,
    htmlBody: `<p>Hi all,</p>
<p>We are ready to sign tomorrow at <strong>09:00 CET</strong>. Please treat the attached funds flow as final unless Clara circulates a replacement before 08:30.</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0">
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Signing</strong></td><td style="border:1px solid #d1d5db;padding:8px">17 July 2026, 09:00 CET</td></tr>
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Escrow</strong></td><td style="border:1px solid #d1d5db;padding:8px">EUR 2,500,000</td></tr>
  <tr><td style="border:1px solid #d1d5db;padding:8px"><strong>Release gate</strong></td><td style="border:1px solid #d1d5db;padding:8px">Signatures + condition 7 waiver</td></tr>
</table>
<p><strong>The EUR 2,500,000 escrow amount must not be released until both signature pages and the condition 7 waiver are confirmed in writing.</strong></p>
<p>Final actions:</p>
<ol>
  <li>Katrin: return the signed supplier consent by 08:15.</li>
  <li>Marcus: confirm the originating account ending 2048.</li>
  <li>Clara: release the completion email after checking all signatures.</li>
</ol>
<p>If anything changes overnight, reply to this thread rather than starting a new one.</p>
<p>Elena</p>`,
    attachments: [
      {
        type: "pdf",
        fileName: "Final_Funds_Flow.pdf",
        title: "Final Funds Flow",
        bodyText:
          "Northstar closing funds flow. Escrow: EUR 2,500,000. Release only after signed pages and the condition 7 waiver are confirmed by closing counsel.",
      },
      {
        type: "text",
        fileName: "Closing_contacts.txt",
        bodyText:
          "Closing counsel: Clara Novak\nEscrow desk: +420 555 010 204\nCompletion bridge: 08:45 CET",
      },
    ],
  },
  "Fwd_ERU_clearance_condition_7.eml": {
    from: "Clara Novak <clara.novak@counsel.example>",
    to: ["Elena Park <elena.park@northstar.example>"],
    cc: ["Deal Team <deal-team@northstar.example>"],
    date: "Wed, 15 Jul 2026 14:18:00 +0200",
    subject: "Fwd: ERÚ clearance received — condition 7 remains open",
    textBody: `Elena,

The regulator has issued the clearance. Condition 7 is still open because the filing requires an updated grid-connection schedule by 20 July 2026.

My recommendation: closing may proceed only if the seller gives the attached undertaking and EUR 2,500,000 remains in escrow.

---------- Forwarded message ---------
From: Regulatory Filings <filings@eru.example>
Date: Wed, 15 Jul 2026 at 13:52
Subject: Decision ERU-2026-184
To: Clara Novak <clara.novak@counsel.example>

The Energy Regulatory Office grants clearance subject to condition 7. The applicant must provide the updated grid-connection schedule no later than 20 July 2026.

Clara`,
    htmlBody: `<p>Elena,</p>
<p>The regulator has issued the clearance. <strong>Condition 7 is still open</strong> because the filing requires an updated grid-connection schedule by 20 July 2026.</p>
<p>My recommendation: closing may proceed only if the seller gives the attached undertaking and EUR 2,500,000 remains in escrow.</p>
<div class="gmail_quote" style="border-left:3px solid #d1d5db;margin:20px 0;padding-left:16px;color:#4b5563">
  <div>---------- Forwarded message ---------</div>
  <div><strong>From:</strong> Regulatory Filings &lt;filings@eru.example&gt;</div>
  <div><strong>Date:</strong> Wed, 15 Jul 2026 at 13:52</div>
  <div><strong>Subject:</strong> Decision ERU-2026-184</div>
  <div><strong>To:</strong> Clara Novak &lt;clara.novak@counsel.example&gt;</div>
  <p>The Energy Regulatory Office grants clearance subject to condition 7. The applicant must provide the updated grid-connection schedule no later than 20 July 2026.</p>
</div>
<p>Clara</p>`,
    attachments: [
      {
        type: "pdf",
        fileName: "Seller_Undertaking_Condition_7.pdf",
        title: "Seller Undertaking — Condition 7",
        bodyText:
          "The seller undertakes to provide the updated grid-connection schedule by 20 July 2026 and accepts that EUR 2,500,000 remains in escrow until written confirmation.",
      },
    ],
  },
  "Client_update_Praha.eml": {
    from: "Karim Haddad <karim.haddad@counsel.example>",
    to: [
      "Petra Malá <petra.mala@energo.example>",
      "ليلى منصور <layla.mansour@northstar.example>",
    ],
    cc: [],
    date: "Tue, 14 Jul 2026 11:06:00 +0200",
    subject: "Client update: Praha / تحديث العميل",
    textBody: `Hello Petra and Layla,

The Prague signing remains scheduled for 17 July 2026. No new corporate approvals are required.

Česky: Prodávající musí dodat aktualizovaný harmonogram připojení nejpozději 20. července 2026. Částka 2 500 000 EUR zůstane v úschově do písemného potvrzení.

العربية: سيبقى مبلغ 2,500,000 يورو في حساب الضمان حتى استلام التأكيد الكتابي. لا يجوز الإفراج عن المبلغ قبل ذلك.

Regards,
Karim`,
    htmlBody: `<p>Hello Petra and Layla,</p>
<p>The Prague signing remains scheduled for <strong>17 July 2026</strong>. No new corporate approvals are required.</p>
<p lang="cs"><strong>Česky:</strong> Prodávající musí dodat aktualizovaný harmonogram připojení nejpozději 20. července 2026. Částka 2 500 000 EUR zůstane v úschově do písemného potvrzení.</p>
<p lang="ar" dir="rtl"><strong>العربية:</strong> سيبقى مبلغ 2,500,000 يورو في حساب الضمان حتى استلام التأكيد الكتابي. لا يجوز الإفراج عن المبلغ قبل ذلك.</p>
<p>Regards,<br>Karim</p>`,
    attachments: [],
  },
} as const satisfies Record<SeedEmailFileName, SeedEmail>;

const MATTER_DOCUMENTS = {
  "ws-akvizice-energo": [
    SPA_DOCUMENT_NAME,
    "Due_Diligence_Report.pdf",
    "Board_Consent_Northstar.docx",
    "Expert_Valuation_Report.pdf",
    "Internal_SAFE_Agreement.docx",
    "Redacted_Due_Diligence_Extract.docx",
    SUPPLIER_AGREEMENT_FILE_NAME,
    ...SEED_EMAIL_FILE_NAMES,
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
} satisfies Record<StandardMatterLabel, readonly string[]>;

/**
 * Realistic extracted text for each document. Keyed by
 * filename so the same text is reused when doc names cycle
 * across extra workspaces. The supplier agreement's text is derived from
 * its tracked-change paragraphs instead.
 */
const DOCUMENT_TEXTS: Record<string, string> = {
  // ws-akvizice-energo
  [SPA_DOCUMENT_NAME]: `SMLOUVA O AKVIZICI AKCIÍ

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

  "Board_Consent_Northstar.docx": `NORTHSTAR ROBOTICS, INC.

UNANIMOUS WRITTEN CONSENT OF THE BOARD OF DIRECTORS

The undersigned, constituting all members of the Board of Directors, approve the issuance of a Simple Agreement for Future Equity to Northstar Seed Fund I, L.P. for a purchase amount of EUR 500,000, subject to a post-money valuation cap of EUR 8,000,000.

The officers of the Company are authorized to execute the agreement and take any action reasonably necessary to complete the financing.

Approved on 15 July 2026.

Elena Park, Director
Daniel Ortiz, Director`,

  "Internal_SAFE_Agreement.docx": `INTERNAL DRAFT — FOR REVIEW ONLY

SAFE
(Simple Agreement for Future Equity)

THIS CERTIFIES THAT in exchange for the payment by Northstar Seed Fund I, L.P. (the “Investor”) of EUR 500,000 on or about 15 July 2026, Northstar Robotics, Inc., a Delaware corporation (the “Company”), issues to the Investor the right to certain shares of the Company’s capital stock, subject to the terms below.

1. EVENTS

Equity Financing. If there is an Equity Financing before this instrument terminates, the Company will automatically issue to the Investor the number of shares of Safe Preferred Stock equal to the Purchase Amount divided by the Conversion Price.

Liquidity Event. If there is a Liquidity Event before this instrument terminates, the Investor will be entitled to receive, immediately before or concurrently with the closing, the greater of the Purchase Amount or the amount payable on the number of shares of Common Stock equal to the Purchase Amount divided by the Liquidity Price.

Dissolution Event. If there is a Dissolution Event before this instrument terminates, the Investor will be entitled to receive the Purchase Amount immediately before the consummation of the Dissolution Event.

2. DEFINITIONS

“Company Capitalization” means the total number of issued and outstanding shares of capital stock of the Company, calculated on a fully diluted basis immediately before the Equity Financing.

“Post-Money Valuation Cap” means EUR 8,000,000.

“Discount Rate” means 80%.

3. COMPANY REPRESENTATIONS

The Company is duly incorporated, validly existing, and in good standing under the laws of Delaware. The execution and performance of this instrument have been duly authorized by the Company’s board of directors.

4. INVESTOR REPRESENTATIONS

The Investor has full legal capacity and authority to execute this instrument and is acquiring it for investment purposes, not with a view to distribution.

5. MISCELLANEOUS

This instrument is governed by the laws of the State of Delaware. Any amendment or waiver must be in writing and signed by the Company and either the Investor or holders of a majority of the aggregate purchase amounts of outstanding instruments with the same Post-Money Valuation Cap and Discount Rate.

NORTHSTAR ROBOTICS, INC.

By: Elena Park, Chief Executive Officer

NORTHSTAR SEED FUND I, L.P.

By: Marcus Chen, General Partner`,

  "Redacted_Due_Diligence_Extract.docx": `CONFIDENTIAL — REDACTED REVIEW COPY

PROJECT NORTHSTAR
LEGAL DUE DILIGENCE EXTRACT

1. PARTIES

Target company: ████████████████████████
Seller: ████████████████████████████████
Buyer: Northstar Robotics, Inc.

2. TRANSACTION VALUE

The proposed purchase price is EUR ███████████, subject to the working-capital adjustment described in Schedule 4.

3. KEY FINDINGS

The target is party to a material supply agreement with ███████████████. The agreement contains a change-of-control clause requiring written consent before completion.

An employment dispute involving █████████████ remains pending. External counsel estimates the maximum exposure at EUR ████████.

4. RECOMMENDATION

Obtain change-of-control consent, require a specific indemnity for the pending dispute, and retain EUR █████████ from the purchase price until the claim is resolved.

Prepared for internal review. Personal names, counterparties, account numbers, and commercially sensitive amounts have been redacted.`,

  "Expert_Valuation_Report.pdf": `ZNALECKÝ POSUDEK č. 127-15/2025
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

const ORG_CONTACTS: SeedLocaleContent["orgContacts"] = [
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
  {
    id: seedId("contact-org-northstar-robotics"),
    type: "organization" as const,
    displayName: "Northstar Robotics, Inc.",
    organizationName: "Northstar Robotics, Inc.",
    registrationNumber: "7483921",
    taxId: "US-94-7483921",
    bankAccounts: [],
    billingAddress: {
      line1: "548 Market Street",
      city: "San Francisco",
      state: "California",
      postalCode: "94104",
      country: "United States",
    },
    defaultHourlyRate: 450,
    currency: "USD",
    paymentTermDays: 30,
    emails: [
      {
        type: "work" as const,
        address: "legal@northstar-robotics.example",
        isPrimary: true,
      },
    ],
    phones: [],
    color: "violet",
  },
];

// Additional org contacts for overview stress-testing
const MORE_ORG_CONTACTS: SeedLocaleContent["moreOrgContacts"] = [
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

const PERSON_CONTACTS: SeedLocaleContent["personContacts"] = [
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

const RECENT_MATTER_ACTIVITY = {
  "2024/059": "2026-07-17T09:00:00.000Z", // Export Review - Project Atlas Data Room (Greenleaf)
  "2026/031": "2026-07-16T15:00:00.000Z", // Meridian supply agreement (Northstar Robotics)
  "2024/058": "2026-07-16T11:00:00.000Z", // Fund IV Structuring (Greenleaf)
  "2024/046": "2026-07-15T16:00:00.000Z", // Sanctions Screening Programme (Crown Shipping)
  "2024/018": "2026-07-15T10:30:00.000Z", // Post-Acquisition Integration (Thames Advisory)
  "2024/003": "2026-07-14T14:00:00.000Z", // Due Diligence - Greenleaf Fund III (Greenleaf)
  "2024/043": "2026-07-14T09:00:00.000Z", // Charter Party Dispute (Crown Shipping)
  "2024/020": "2026-07-13T15:00:00.000Z", // Anti-Bribery Compliance Review (Thames Advisory)
  "2024/007": "2026-07-13T10:00:00.000Z", // Cross-border M&A Advisory (Greenleaf)
  "2024/016": "2026-07-12T14:00:00.000Z", // Shareholder Dispute Resolution (Thames Advisory)
};

const NOTES = [
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

const TIME_ENTRY_NARRATIVES = [
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

const EXTRA_MATTERS = [
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

const COLLEAGUES = getSeedColleagues(3);

/** Small counts read as words in prose ("four counterparties"). */
const countWord = (count: number) =>
  [
    "no",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ].at(count) ?? String(count);

export const EN_SEED_CONTENT = {
  colleagues: [at(COLLEAGUES, 0), at(COLLEAGUES, 1), at(COLLEAGUES, 2)],
  ownerHourlyRate: 6500,
  currency: "CZK",

  orgContacts: ORG_CONTACTS,
  personContacts: PERSON_CONTACTS,
  moreOrgContacts: MORE_ORG_CONTACTS,

  matters: {
    "ws-akvizice-energo": {
      // The matter the marketing editor scenes film: its breadcrumb frames
      // the Supplier_Agreement.docx redline (Northstar Robotics buying drive
      // components from Meridian Precision), so the name stays
      // supplier-themed.
      name: "Meridian supply agreement",
      reference: "2026/031",
      clientIndex: 4, // Northstar Robotics
      billingReference: "NS-SUPPLY-2026",
    },
    "ws-stavebni-spor": {
      name: "Stavební spor - Brno Centrál",
      reference: "2024/002",
      clientIndex: 2, // Moravská stavební
      billingReference: "MS-LIT-2024",
    },
    "ws-due-diligence": {
      name: "Due Diligence - Greenleaf Fund III",
      reference: "2024/003",
      clientIndex: 3, // Greenleaf
      billingReference: "GL-DD-2024",
    },
    "ws-pracovni-spory": {
      name: "Pracovní spory - Novák",
      reference: "2024/004",
      clientIndex: 0, // Novák & Partners
    },
    "ws-compliance-ceska-energie": {
      name: "Compliance program",
      reference: "2024/005",
      clientIndex: 1, // Česká Energie
      billingReference: "CE-COMP-2024",
    },
    "ws-reorganizace": {
      name: "Reorganizace skupiny",
      reference: "2024/006",
      clientIndex: 0, // Novák & Partners
    },
    "ws-cross-border": {
      name: "Cross-border M&A Advisory",
      reference: "2024/007",
      clientIndex: 3, // Greenleaf
      billingReference: "GL-MA-2024",
    },
    "ws-gdpr-audit": {
      name: "GDPR Audit a implementace",
      reference: "2024/008",
      clientIndex: 2, // Moravská stavební
      billingReference: "MS-GDPR-2024",
    },
    "ws-export-review": {
      name: "Export Review - Project Atlas Data Room",
      reference: "2024/059",
      clientIndex: 3, // Greenleaf
      billingReference: "GL-EXPORT-2024",
    },
  },
  extraMatters: EXTRA_MATTERS,
  recentMatterActivity: RECENT_MATTER_ACTIVITY,

  matterDocuments: MATTER_DOCUMENTS,
  documentTexts: DOCUMENT_TEXTS,
  emails: SEED_EMAILS,
  spaDocumentName: SPA_DOCUMENT_NAME,
  supplierAgreement: {
    fileName: SUPPLIER_AGREEMENT_FILE_NAME,
    baseFileName: "Supplier_Agreement_v3.docx",
    baseVersionLabel: "Initial draft",
    currentVersionLabel: "Negotiated draft",
    draftMarker: "NEGOTIATION DRAFT v4 — CONTAINS TRACKED CHANGES",
    baseDraftMarker: "NEGOTIATION DRAFT v3",
    reviewer: SUPPLIER_AGREEMENT_REVIEWER,
    comments: SUPPLIER_AGREEMENT_COMMENTS,
    paragraphs: SUPPLIER_AGREEMENT_PARAGRAPHS,
    note: "Two positions outside playbook",
  },

  folders: { documents: "Documents" },
  properties: {
    documents: "Documents",
    status: "Status",
    notes: "Notes",
    dueDate: "Due Date",
    documentType: "Document Type",
    statusOptions: ["Active", "In Review", "Closed", "On Hold"],
    documentTypePrompt: "Extract the document category from the attached file.",
  },
  notes: NOTES,
  documentTypeLabels: {
    nda: "Non-Disclosure Agreement",
    spa: "Share Purchase Agreement",
    apa: "Asset Purchase Agreement",
    shareholders: "Shareholders' Agreement",
    msa: "Master Services Agreement",
    sla: "Service Level Agreement",
    dpa: "Data Processing Agreement",
    saas: "SaaS Agreement",
    employment: "Employment Agreement",
    consultancy: "Consultancy Agreement",
    lease: "Lease Agreement",
    loan: "Loan / Facility Agreement",
    guarantee: "Guarantee",
    poa: "Power of Attorney",
    license: "Licence Agreement",
    distribution: "Distribution Agreement",
    supply: "Supply Agreement",
    settlement: "Settlement Agreement",
    termsheet: "Term Sheet / LOI",
    other: "Other",
  },

  exportReview: {
    folders: [
      "Corporate",
      "Commercial",
      "Employment",
      "Regulatory",
      "Finance",
      "Real Estate",
    ],
    documentTypes: [
      "Shareholder Register",
      "Customer Contract",
      "Supplier Agreement",
      "Employment Agreement",
      "Permit",
      "Loan Agreement",
      "Lease",
      "Insurance Policy",
    ],
    counterparties: [
      "Aurora Retail GmbH",
      "BluePeak Manufacturing s.r.o.",
      "Cedar Cloud Ltd.",
      "Delta Logistics Kft.",
      "Edison Bank plc",
      "Fjord Analytics AB",
      "Granite Properties B.V.",
      "Helios Energy a.s.",
    ],
    jurisdictions: [
      "Czech Republic",
      "Germany",
      "Netherlands",
      "Hungary",
      "United Kingdom",
    ],
    governingLaws: [
      "Czech Republic",
      "Germany",
      "Netherlands",
      "Hungary",
      "England and Wales",
    ],
    riskLevels: ["Low", "Medium", "High", "Critical"],
    reviewStatuses: ["Not Started", "In Review", "Needs Partner", "Cleared"],
    evidenceQuality: [
      "Direct citation",
      "Needs source check",
      "Conflicting evidence",
    ],
    primaryTags: ["change of control", "termination", "data room", "renewal"],
    secondaryTags: ["consent needed", "pricing", "privacy", "security"],
    keyObligation: (counterparty) =>
      `${counterparty} must provide written notice before any assignment, renewal, or material service change.`,
    riskFinding: {
      elevated:
        "Consent, notice, or termination rights require partner review before signing.",
      ordinary:
        "No blocking issue identified; confirm ordinary-course compliance before closing.",
    },
    formatContractValue: (value) => `EUR ${value}`,
    extract: {
      heading: (documentType) =>
        `${documentType.toUpperCase()} — REVIEW EXTRACT`,
      intro: ({ counterparty, documentType, jurisdiction }) =>
        `${counterparty}, based in ${jurisdiction}, is party to this ${documentType.toLowerCase()} under review as part of the Project Atlas data room.`,
      keyTerms: "Key terms",
      labels: {
        document: "Document",
        documentType: "Document type",
        counterparty: "Counterparty",
        jurisdiction: "Jurisdiction",
        governingLaw: "Governing law",
        effectiveDate: "Effective date",
        expiryDate: "Expiry date",
        contractValue: "Contract value",
        riskLevel: "Risk level",
        reviewStatus: "Review status",
        evidenceQuality: "Evidence quality",
        tags: "Tags",
      },
      keyObligation: "Key obligation",
      riskFinding: "Risk finding",
      underReview: "Extract under review:",
      clause: ({ counterparty, governingLaw }) =>
        `"${counterparty} must comply with the obligation identified above and the governing law is ${governingLaw}."`,
    },
    statements: {
      "document-type": (row) =>
        `Document type extracted as ${row.documentType}.`,
      counterparty: (row) => `Counterparty extracted as ${row.counterparty}.`,
      jurisdiction: (row) => `Jurisdiction extracted as ${row.jurisdiction}.`,
      "governing-law": (row) =>
        `Governing law extracted as ${row.governingLaw}.`,
      "effective-date": (row) =>
        `Effective date extracted as ${row.effectiveDate}.`,
      "expiry-date": (row) => `Expiry date extracted as ${row.expiryDate}.`,
      "contract-value": (row) =>
        `Contract value extracted as EUR ${row.contractValue}.`,
      "risk-level": (row) => `Risk level classified as ${row.riskLevel}.`,
      "evidence-quality": (row) =>
        `Evidence quality classified as ${row.evidenceQuality}.`,
      tags: (row) => `Tags extracted as ${row.tags.join(", ")}.`,
      "key-obligation": () =>
        "Key obligation extracted from the obligation section.",
      "risk-finding": () => "Risk finding extracted from the risk section.",
    },
    columns: {
      documentType: {
        name: "Document Type",
        prompt: "Extract the document category from the attached file.",
      },
      counterparty: {
        name: "Counterparty",
        prompt: "Extract the primary counterparty named in the document.",
      },
      jurisdiction: {
        name: "Jurisdiction",
        prompt: "Extract the relevant jurisdiction from the document.",
      },
      governingLaw: {
        name: "Governing Law",
        prompt: "Extract the governing law clause.",
      },
      effectiveDate: {
        name: "Effective Date",
        prompt: "Extract the effective date as an ISO date.",
      },
      expiryDate: {
        name: "Expiry Date",
        prompt: "Extract the expiry or renewal date as an ISO date.",
      },
      contractValue: {
        name: "Contract Value",
        prompt: "Extract the contract value in euros.",
      },
      riskLevel: {
        name: "Risk Level",
        prompt: "Classify the diligence risk level.",
      },
      reviewStatus: { name: "Review Status" },
      evidenceQuality: {
        name: "Evidence Quality",
        prompt: "Assess whether the extracted value has direct support.",
      },
      tags: { name: "Tags", prompt: "Extract concise diligence tags." },
      keyObligation: {
        name: "Key Obligation",
        prompt: "Extract the key obligation relevant to closing.",
      },
      riskFinding: {
        name: "Risk Finding",
        prompt: "Summarize the key diligence risk in one sentence.",
      },
    },
  },

  agent: {
    formattingLocale: exposureView.data.formattingLocale,
    viewLabels: exposureView.data.labels,
    agreementLabel: (documentType, year) => `${documentType} ${year}`,
    firstAnswerIntro: ({ documentCount, consentCount }) =>
      `I checked all ${String(documentCount)} documents in the data room. Every agreement requires written notice before an assignment, renewal or material service change, so a change of control triggers at least a notice everywhere. Only ${countWord(consentCount)} counterparties go further: their review extracts flag consent or termination rights that need partner review before signing.`,
    tableColumns: [
      "Counterparty",
      "Agreement",
      "Risk",
      "Change-of-control position",
    ],
    firstAnswerOutro: ({ confirmNames }) =>
      `The ${confirmNames} agreements report no blocking issue, but each is tagged "consent needed", so confirm the consent position before signing.`,
    secondAnswerLead: ({
      counterparty,
      criticalCount,
      riskFinding,
      riskFindingCitation,
      keyObligation,
      keyObligationCitation,
    }) =>
      `The ${counterparty} loan agreement is one of the ${countWord(criticalCount)} Critical items. Its review extract records that "${riskFinding}" ${riskFindingCitation} That sits on top of the standard duty: "${keyObligation}" ${keyObligationCitation}`,
    citationLabels: {
      riskFinding: "Risk finding",
      keyObligation: "Key obligation",
      governingLaw: "Governing law",
      expiryDate: "Expiry date",
      contractValue: "Contract value",
    },
    factLabels: {
      governingLaw: "Governing law",
      expires: "Expires",
      contractValue: "Contract value",
    },
    thirdAnswerLead: ({
      share,
      consentValue,
      totalValue,
      consentCount,
      criticalCount,
      firstCriticalCitation,
      secondCriticalCitation,
    }) =>
      `Here is the exposure by counterparty. ${share} of the contract value in the data room (${consentValue} of ${totalValue}) sits with the ${countWord(consentCount)} counterparties that need consent or termination review, led by the ${countWord(criticalCount)} Critical agreements: ${firstCriticalCitation} and ${secondCriticalCitation}.`,
    thirdAnswerFollowUp: ({ confirmNames, consentCount }) =>
      `Next: confirm the consent position with ${confirmNames}, then draft the consent requests for the ${countWord(consentCount)} counterparties under review.`,
    recap: ({ consentNames, confirmNames }) =>
      `You mapped change-of-control exposure across the Project Atlas data room: ${consentNames} need consent or termination review, and an exposure view summarises it for the partner meeting. Still open: confirm the consent position for ${confirmNames}.`,
  },

  billing: {
    taskCodeLabels: {
      RESEARCH: "Legal research",
      REVIEW: "Document review",
      DRAFT: "Drafting",
      MEETING: "Meeting / conference",
      COURT: "Court appearance",
      FILING: "Filing and service",
      DISCOVERY: "Discovery",
      NEGOTIATE: "Negotiation",
      ADVISE: "Advisory",
      ADMIN: "Administrative",
    },
    activityCodeLabels: {
      PLAN: "Planning and strategy",
      COMMUNICATE: "Communication",
      ANALYZE: "Analysis",
      MANAGE: "Case management",
      TRAVEL: "Travel",
      ATTEND: "Attendance",
      PREPARE: "Preparation",
      CORRESPOND: "Correspondence",
    },
    timeEntryNarratives: TIME_ENTRY_NARRATIVES,
    invoiceEntryNarratives: [
      "Review of target corporate records against the legal DD checklist",
      "Analysis of group structure and shareholder register",
      "Review of regulatory permits and compliance findings",
      "Red-flag summary of change-of-control clauses in material contracts",
      "Mark-up of share purchase agreement warranties and indemnities",
      "Call with client on disclosure schedule and SPA comments",
    ],
    expenseDescriptions: EXPENSE_DESCRIPTIONS,
    rateTableName: "Default Rate Table",
    invoiceNumberPrefix: "INV",
  },
  issuing: {
    seller: {
      legalName: "Stella Demo Legal s.r.o.",
      registrationId: "12345678",
      vatId: "CZ12345678",
      addressLine1: "Vodičkova 12",
      city: "Praha",
      postalCode: "110 00",
      country: "CZ",
      iban: "CZ6508000000192000145399",
    },
    vatRates: {
      standard: {
        name: "Standard rate",
        rateBps: 2100,
        validFrom: "2013-01-01",
      },
      reduced: { name: "Reduced rate", rateBps: 1200, validFrom: "2024-01-01" },
    },
    numberSeriesName: "Invoices",
  },
  templates: {
    categories: {
      "tmpl-cat-corporate": {
        name: "Corporate",
        description:
          "Share purchase, shareholder, and board resolution templates.",
      },
      "tmpl-cat-employment": {
        name: "Employment",
        description: "Employment contracts, NDAs, and HR-related templates.",
      },
      "tmpl-cat-commercial": {
        name: "Commercial",
        description:
          "Master services, SLA, and commercial agreement templates.",
      },
      "tmpl-cat-real-estate": {
        name: "Real Estate",
        description:
          "Lease agreements, licences, and property transaction templates.",
      },
    },
    templates: {
      "tmpl-spa": {
        name: "Share Purchase Agreement",
        fileName: "Share_Purchase_Agreement.docx",
      },
      "tmpl-board-resolution": {
        name: "Board Resolution",
        fileName: "Board_Resolution.docx",
      },
      "tmpl-shareholders": {
        name: "Shareholders' Agreement",
        fileName: "Shareholders_Agreement.docx",
      },
      "tmpl-employment": {
        name: "Employment Agreement",
        fileName: "Employment_Agreement.docx",
      },
      "tmpl-nda": {
        name: "Non-Disclosure Agreement",
        fileName: "Non_Disclosure_Agreement.docx",
      },
      "tmpl-msa": {
        name: "Master Services Agreement",
        fileName: "Master_Services_Agreement.docx",
      },
      "tmpl-sla": {
        name: "Service Level Agreement",
        fileName: "Service_Level_Agreement.docx",
      },
      "tmpl-supply": {
        name: "Supply Agreement",
        fileName: "Supply_Agreement.docx",
      },
      "tmpl-lease": {
        name: "Lease Agreement",
        fileName: "Lease_Agreement.docx",
      },
    },
  },
} satisfies SeedLocaleContent;
