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

import { createHash } from "node:crypto";

import { db } from "@/api/db";
import {
  billingCodes,
  contacts,
  entities,
  entityVersions,
  expenses,
  fields,
  invoices,
  properties,
  rateEntries,
  rateTables,
  timeEntries,
  views,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import type {
  EntityKind,
  FieldContent,
  PropertyContent,
  PropertyTool,
  ViewConfig,
} from "@/api/db/schema-validators";
import { s3 } from "@/api/lib/s3";
import { DEFAULT_VIEWS, type RequiredViewLayout } from "@/api/lib/views";
import { ensureTestUsers } from "./seed-test-user";

// ─── Constants ──────────────────────────────────────────

const DEFAULT_USER_ID = "test-user-stella-dev";
const DEFAULT_ORG_ID = "test-org-stella-dev";

const ALL_USER_IDS = [
  DEFAULT_USER_ID,
  "test-user-alice-johnson",
  "test-user-bob-martinez",
  "test-user-clara-novak",
  "test-user-david-kim",
  "test-user-eva-schmidt",
  "test-user-frank-horvat",
  "test-user-greta-jones",
];

const pickAuthor = (index: number): string =>
  ALL_USER_IDS[index % ALL_USER_IDS.length];

// ─── Deterministic ID generator ─────────────────────────

const seedId = (label: string): string => {
  const hash = createHash("sha256").update(label).digest("hex");
  return hash.slice(0, 21);
};

/** Safe array access for seed data (panics on out-of-bounds). */
const at = <T>(arr: readonly T[], i: number): T => {
  const item = arr[i];
  if (item === undefined) {
    throw new Error(`Seed data: index ${i} out of bounds`);
  }
  return item;
};

// ─── Mock file generators ───────────────────────────────

const fileExtRe = /\.(pdf|docx)$/;

const PDF_MIME = "application/pdf" as const;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

const createMockPdf = (title: string): Buffer => {
  const textStream = `BT /F1 16 Tf 72 700 Td (${title}) Tj ET`;
  const streamLength = textStream.length;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>\nendobj",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj",
    `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${textStream}\nendstream\nendobj`,
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += `${obj}\n`;
  }

  const xrefOffset = body.length;
  body += "xref\n";
  body += `0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += "trailer\n";
  body += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += "startxref\n";
  body += `${xrefOffset}\n`;
  body += "%%EOF\n";

  return Buffer.from(body);
};

const createMockDocx = async (title: string): Promise<Buffer> => {
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

  zip
    .folder("word")
    ?.file(
      "document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        "<w:body>" +
        '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>' +
        title +
        "</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>This is a mock document for development purposes.</w:t></w:r></w:p>" +
        "</w:body>" +
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

// ─── Views (per-workspace) ──────────────────────────────

type ViewSeed = {
  id: string;
  workspaceId: string;
  name: string;
  layout: RequiredViewLayout;
  config: ViewConfig;
  position: number;
};

const buildViews = (wsId: string, wsLabel: string): ViewSeed[] =>
  DEFAULT_VIEWS.map((v) => ({
    id: seedId(`${wsLabel}-view-${v.layout}`),
    workspaceId: wsId,
    ...v,
  }));

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
      propertyId: dueDatePropId,
      entityVersionId: doc.versionId,
      content: {
        version: 1,
        type: "date",
        value: seedDueDate(
          // Use wsLabel hash + doc index for variety
          seedId(`${wsLabel}-${i}`).charCodeAt(0) + i,
        ),
      },
    });

    // Notes field
    const noteIndex =
      (seedId(`${wsLabel}-note-${i}`).charCodeAt(0) + i) % notes.length;
    result.push({
      id: seedId(`${wsLabel}-field-notes-${i}`),
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
  const statuses = ["draft", "finalized", "sent", "paid", "sent"] as const;
  const invoiceSeeds: InvoiceSeed[] = [];
  for (let i = 0; i < 5; i++) {
    const wsIndex = i % seedWorkspaces.length;
    const ws = at(seedWorkspaces, wsIndex);
    invoiceSeeds.push({
      id: seedId(`invoice-${i}`),
      workspaceId: ws.id,
      invoiceNumber: `INV-2025-${String(i + 1).padStart(4, "0")}`,
      status: at(statuses, i),
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
  const ORG_ID = organizationId ?? DEFAULT_ORG_ID;
  const USER_ID = userId ?? DEFAULT_USER_ID;

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

    // Default views for extra workspaces
    for (const v of DEFAULT_VIEWS) {
      await db
        .insert(views)
        .values({
          id: seedId(`extra-ws-${mw.reference}-view-${v.layout}`),
          workspaceId: wsId,
          ...v,
        })
        .onConflictDoNothing();
    }

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
        workspaceId: prop.workspaceId,
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

  // 4. Views
  const allViews: ViewSeed[] = [];
  for (let i = 0; i < seedWorkspaces.length; i++) {
    allViews.push(...buildViews(at(seedWorkspaces, i).id, at(wsLabels, i)));
  }
  for (const v of allViews) {
    await db
      .insert(views)
      .values({
        id: v.id,
        workspaceId: v.workspaceId,
        name: v.name,
        layout: v.layout,
        config: v.config,
        position: v.position,
      })
      .onConflictDoNothing();
  }
  console.log(
    `  Views: ${allViews.length} (${allViews.length / seedWorkspaces.length}/workspace)`,
  );

  // 5. Entities + entity versions
  const allEntities: EntitySeed[] = [];
  for (let i = 0; i < seedWorkspaces.length; i++) {
    allEntities.push(
      ...buildEntities(at(seedWorkspaces, i).id, at(wsLabels, i)),
    );
  }
  for (let ei = 0; ei < allEntities.length; ei++) {
    const e = allEntities[ei];
    await db
      .insert(entities)
      .values({
        id: e.entityId,
        workspaceId: e.workspaceId,
        kind: e.kind,
        parentId: e.parentId,
        createdBy: pickAuthor(ei),
      })
      .onConflictDoNothing();

    await db
      .insert(entityVersions)
      .values({
        id: e.versionId,
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

  // 6. File fields (generate files, upload to S3, insert fields)
  // For DOCX files, also create a PDF "converted twin" as if
  // Gotenberg had converted it.
  let fileCount = 0;
  let pdfTwinCount = 0;
  for (let i = 0; i < seedWorkspaces.length; i++) {
    const ws = at(seedWorkspaces, i);
    const wsLabel = at(wsLabels, i);
    const filePropertyId = seedId(`${wsLabel}-prop-file`);
    const docNames = workspaceDocNames[wsLabel];
    if (!docNames) {
      continue;
    }

    const docEntities = allEntities.filter(
      (e) => e.workspaceId === ws.id && e.kind === "document",
    );

    for (let j = 0; j < docEntities.length; j++) {
      const entity = at(docEntities, j);
      const fileName = at(docNames, j);
      const isDocx = fileName.endsWith(".docx");
      const mimeType = isDocx ? DOCX_MIME : PDF_MIME;
      const ext = isDocx ? "docx" : "pdf";

      const title = fileName.replace(fileExtRe, "").replaceAll("_", " ");

      const content = isDocx
        ? await createMockDocx(title)
        : createMockPdf(title);

      const sha256Hex = new Bun.CryptoHasher("sha256")
        .update(content)
        .digest("hex");

      const fileId = seedId(`${wsLabel}-file-${j}`);
      const s3Key = `${ORG_ID}/${ws.id}/${fileId}.${ext}`;

      await s3.write(s3Key, new Uint8Array(content));

      // For DOCX files, create a PDF converted twin
      let pdfFileId: string | null = null;
      if (isDocx) {
        pdfFileId = seedId(`${wsLabel}-pdf-twin-${j}`);
        const pdfContent = createMockPdf(title);
        const pdfS3Key = `${ORG_ID}/${ws.id}/${pdfFileId}.pdf`;
        await s3.write(pdfS3Key, new Uint8Array(pdfContent));
        pdfTwinCount++;
      }

      await db
        .insert(fields)
        .values({
          id: seedId(`${wsLabel}-field-file-${j}`),
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
    }
  }
  console.log(
    `  Files: ${fileCount} (uploaded to S3, ${pdfTwinCount} PDF twins)`,
  );

  // 7. Fields (status for each document)
  const allFields: FieldSeed[] = [];
  for (let i = 0; i < seedWorkspaces.length; i++) {
    const wsEntities = allEntities.filter(
      (e) => e.workspaceId === at(seedWorkspaces, i).id,
    );
    allFields.push(...buildFields(at(wsLabels, i), wsEntities));
  }
  for (const f of allFields) {
    await db
      .insert(fields)
      .values({
        id: f.id,
        propertyId: f.propertyId,
        entityVersionId: f.entityVersionId,
        content: f.content,
      })
      .onConflictDoNothing();
  }
  console.log(`  Fields: ${allFields.length}`);

  // 8. Workspace contacts (parties)
  for (const party of seedParties) {
    await db
      .insert(workspaceContacts)
      .values({
        id: party.id,
        organizationId: ORG_ID,
        workspaceId: party.workspaceId,
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
        workspaceId: bc.workspaceId,
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
        workspaceId: rt.workspaceId,
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
        workspaceId: inv.workspaceId,
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
        workspaceId: te.workspaceId,
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
        workspaceId: exp.workspaceId,
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
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
