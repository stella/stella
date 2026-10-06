/**
 * The fictional data the restricted review organization holds. Every person,
 * firm, company, address and number here is invented; none refers to a real
 * one. Keys are stable: they derive the deterministic ids the seeder writes,
 * so changing a key reseeds that item under a new id.
 */

export type SampleContact =
  | {
      key: string;
      type: "organization";
      organizationName: string;
      registrationNumber: string;
      email: string;
      notes: string;
    }
  | {
      key: string;
      type: "person";
      firstName: string;
      lastName: string;
      email: string;
      notes: string;
    };

export type SampleDocument = {
  /** Unique within its matter; the seeder skips a name already present. */
  fileName: string;
  format: "docx" | "pdf";
  title: string;
  /** Markdown for DOCX, plain lines for PDF. */
  body: string;
};

export type SampleTask = {
  key: string;
  name: string;
  status: "open" | "in_progress" | "done";
  priority: "none" | "low" | "medium" | "high";
  dueDate: string;
};

export type SampleTimeEntry = {
  dateWorked: string;
  durationMinutes: number;
  narrative: string;
};

export type SampleMatter = {
  key: string;
  name: string;
  clientKey: string;
  documents: readonly SampleDocument[];
  tasks: readonly SampleTask[];
  timeEntries: readonly SampleTimeEntry[];
};

export const SAMPLE_CONTACTS = [
  {
    key: "brightwater",
    type: "organization",
    organizationName: "Brightwater Lantern Works Ltd.",
    registrationNumber: "SAMPLE-0001",
    email: "office@brightwater-lanterns.example",
    notes: "Fictional client used in sample data.",
  },
  {
    key: "kovarna",
    type: "organization",
    organizationName: "Kovárna Hvězdný Vrch s.r.o.",
    registrationNumber: "SAMPLE-0002",
    email: "kancelar@hvezdny-vrch.example",
    notes: "Fiktivní klient pro ukázková data.",
  },
  {
    key: "modrasek",
    type: "organization",
    organizationName: "Modrásek Software a.s.",
    registrationNumber: "SAMPLE-0003",
    email: "legal@modrasek-software.example",
    notes: "Fictional software vendor used in sample data.",
  },
  {
    key: "marta",
    type: "person",
    firstName: "Marta",
    lastName: "Ukázková",
    email: "marta.ukazkova@hvezdny-vrch.example",
    notes: "Jednatelka fiktivní společnosti Kovárna Hvězdný Vrch.",
  },
  {
    key: "oliver",
    type: "person",
    firstName: "Oliver",
    lastName: "Testwood",
    email: "oliver.testwood@brightwater-lanterns.example",
    notes: "Procurement lead at the fictional Brightwater Lantern Works.",
  },
] as const satisfies readonly SampleContact[];

export type SampleContactKey = (typeof SAMPLE_CONTACTS)[number]["key"];

export const SAMPLE_MATTERS = [
  {
    key: "brightwater-supply",
    name: "Brightwater – supply agreement review",
    clientKey: "brightwater",
    documents: [
      {
        fileName: "Supply Agreement Draft.docx",
        format: "docx",
        title: "Supply Agreement (draft)",
        body: [
          "# Supply Agreement",
          "",
          "This Supply Agreement is made between **Brightwater Lantern Works Ltd.** (the Buyer) and **Glimmerfield Components Ltd.** (the Supplier).",
          "",
          "## 1. Supply",
          "The Supplier shall deliver lantern housings in accordance with the delivery schedule in Annex 1.",
          "",
          "## 2. Price and payment",
          "The Buyer shall pay each invoice within 45 days of receipt.",
          "",
          "## 3. Liability",
          "Each party's total liability under this Agreement is limited to the fees paid in the twelve months before the claim.",
          "",
          "## 4. Governing law",
          "This Agreement is governed by the laws of England and Wales.",
        ].join("\n"),
      },
      {
        fileName: "Delivery Schedule.pdf",
        format: "pdf",
        title: "Annex 1 - Delivery schedule",
        body: [
          "Annex 1 to the Supply Agreement",
          "",
          "Batch A: 500 housings, delivery within 30 days of order.",
          "Batch B: 750 housings, delivery within 60 days of order.",
          "Late delivery credit: 0.5 % of the batch price per week, capped at 5 %.",
        ].join("\n"),
      },
      {
        fileName: "Negotiation Notes.docx",
        format: "docx",
        title: "Negotiation notes",
        body: [
          "# Negotiation notes",
          "",
          "- The Supplier asks for 30-day payment terms; we offered 45 days.",
          "- The liability cap is acceptable if it excludes confidentiality breaches.",
          "- Open point: who bears the cost of rejected batches.",
        ].join("\n"),
      },
    ],
    tasks: [
      {
        key: "markup",
        name: "Send the mark-up of the supply agreement",
        status: "in_progress",
        priority: "high",
        dueDate: "2026-11-02",
      },
      {
        key: "annex",
        name: "Check the delivery schedule against the order forecast",
        status: "open",
        priority: "medium",
        dueDate: "2026-11-09",
      },
    ],
    timeEntries: [
      {
        dateWorked: "2026-09-14",
        durationMinutes: 90,
        narrative: "Reviewed the supplier's draft supply agreement.",
      },
      {
        dateWorked: "2026-09-15",
        durationMinutes: 45,
        narrative: "Call with the client on payment terms and liability.",
      },
    ],
  },
  {
    key: "kovarna-lease",
    name: "Kovárna Hvězdný Vrch – nájem provozovny",
    clientKey: "kovarna",
    documents: [
      {
        fileName: "Najemni smlouva.docx",
        format: "docx",
        title: "Nájemní smlouva",
        body: [
          "# Smlouva o nájmu prostoru sloužícího k podnikání",
          "",
          "Pronajímatel: **Statek Lipová Alej s.r.o.**",
          "Nájemce: **Kovárna Hvězdný Vrch s.r.o.**",
          "",
          "## Článek 1 – Předmět nájmu",
          "Pronajímatel přenechává nájemci do užívání dílnu o výměře 240 m² v areálu Lipová Alej.",
          "",
          "## Článek 2 – Nájemné",
          "Nájemné činí 38 000 Kč měsíčně a je splatné vždy do 15. dne kalendářního měsíce.",
          "",
          "## Článek 3 – Doba nájmu",
          "Nájem se sjednává na dobu určitou pěti let s opcí na prodloužení.",
        ].join("\n"),
      },
      {
        fileName: "Predavaci protokol.pdf",
        format: "pdf",
        title: "Predavaci protokol",
        body: [
          "Předávací protokol k nájmu dílny v areálu Lipová Alej",
          "",
          "Stav měřidel: elektřina 10 412 kWh, voda 318 m3.",
          "Předané klíče: 4 ks od hlavní brány, 2 ks od dílny.",
          "Zjištěné vady: prasklé sklo v okně severní stěny.",
        ].join("\n"),
      },
    ],
    tasks: [
      {
        key: "opce",
        name: "Ověřit podmínky opce na prodloužení nájmu",
        status: "open",
        priority: "medium",
        dueDate: "2026-11-16",
      },
      {
        key: "vady",
        name: "Uplatnit vadu okna u pronajímatele",
        status: "done",
        priority: "low",
        dueDate: "2026-10-01",
      },
    ],
    timeEntries: [
      {
        dateWorked: "2026-09-21",
        durationMinutes: 120,
        narrative: "Revize návrhu nájemní smlouvy a příprava připomínek.",
      },
      {
        dateWorked: "2026-09-23",
        durationMinutes: 30,
        narrative: "Kontrola předávacího protokolu.",
      },
    ],
  },
  {
    key: "modrasek-nda",
    name: "Modrásek Software – NDA and data processing",
    clientKey: "modrasek",
    documents: [
      {
        fileName: "Mutual NDA.docx",
        format: "docx",
        title: "Mutual non-disclosure agreement",
        body: [
          "# Mutual Non-Disclosure Agreement",
          "",
          "Between **Modrásek Software a.s.** and **Quillstone Analytics Ltd.**",
          "",
          "## 1. Confidential information",
          "Confidential information means any non-public information disclosed by one party to the other.",
          "",
          "## 2. Term",
          "The obligations last three years from the date of disclosure.",
          "",
          "## 3. Governing law",
          "Toto ujednání se řídí právem České republiky.",
        ].join("\n"),
      },
      {
        fileName: "Data Processing Addendum.pdf",
        format: "pdf",
        title: "Data processing addendum (draft)",
        body: [
          "Data processing addendum",
          "",
          "Controller: Quillstone Analytics Ltd. Processor: Modrásek Software a.s.",
          "Sub-processors require prior written notice of 30 days.",
          "Personal data breaches are notified without undue delay and within 48 hours.",
        ].join("\n"),
      },
    ],
    tasks: [
      {
        key: "subprocessors",
        name: "Confirm the sub-processor list with the client",
        status: "open",
        priority: "high",
        dueDate: "2026-11-05",
      },
    ],
    timeEntries: [
      {
        dateWorked: "2026-09-28",
        durationMinutes: 60,
        narrative: "Reviewed the mutual NDA and the data processing addendum.",
      },
    ],
  },
] as const satisfies readonly SampleMatter[];

export type SampleClause = {
  title: string;
  language: string;
  description: string;
  paragraphs: readonly string[];
};

export const SAMPLE_CLAUSES = [
  {
    title: "Governing law (England and Wales)",
    language: "en",
    description: "Sample governing-law clause.",
    paragraphs: [
      "This Agreement and any non-contractual obligations arising out of it are governed by the laws of England and Wales.",
    ],
  },
  {
    title: "Mlčenlivost",
    language: "cs",
    description: "Ukázkové ustanovení o mlčenlivosti.",
    paragraphs: [
      "Smluvní strany se zavazují zachovávat mlčenlivost o všech důvěrných informacích, které se dozvěděly v souvislosti s touto smlouvou.",
    ],
  },
] as const satisfies readonly SampleClause[];

export const SAMPLE_TEMPLATE = {
  name: "Sample power of attorney",
  fileName: "Sample power of attorney.docx",
  body: [
    "# Power of attorney",
    "",
    "I, {{principal_name}}, appoint {{agent_name}} to act on my behalf in the matter {{matter_name}}.",
    "",
    "Signed on {{signing_date}}.",
  ].join("\n"),
} as const;

export type SamplePlaybookPosition = {
  key: string;
  issue: string;
  severity: "low" | "medium" | "high" | "blocker";
  question: string;
  ideal: string;
  fallback: string;
  redLine: string;
};

export const SAMPLE_PLAYBOOK = {
  key: "nda-review",
  name: "Sample NDA review",
  description:
    "Sample playbook for reviewing mutual non-disclosure agreements.",
  positions: [
    {
      key: "term",
      issue: "Duration of confidentiality",
      severity: "medium",
      question:
        "How long do the confidentiality obligations last? Quote the operative wording.",
      ideal: "The obligations last at least three years from disclosure.",
      fallback: "The obligations last two years from disclosure.",
      redLine: "The obligations end when the agreement terminates.",
    },
    {
      key: "law",
      issue: "Governing law",
      severity: "high",
      question: "Which law governs the agreement?",
      ideal: "Czech law governs the agreement.",
      fallback: "The law of another EU member state governs the agreement.",
      redLine: "A law outside the EU governs the agreement.",
    },
  ],
} as const satisfies {
  key: string;
  name: string;
  description: string;
  positions: readonly SamplePlaybookPosition[];
};

/** How many items of each kind a complete seed holds. */
export const SAMPLE_COUNTS = {
  contacts: SAMPLE_CONTACTS.length,
  matters: SAMPLE_MATTERS.length,
  documents: SAMPLE_MATTERS.reduce(
    (total, matter) => total + matter.documents.length,
    0,
  ),
  tasks: SAMPLE_MATTERS.reduce(
    (total, matter) => total + matter.tasks.length,
    0,
  ),
  timeEntries: SAMPLE_MATTERS.reduce(
    (total, matter) => total + matter.timeEntries.length,
    0,
  ),
  clauses: SAMPLE_CLAUSES.length,
  templates: 1,
  playbooks: 1,
} as const;
