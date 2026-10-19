// The language-dependent half of the development seed: every name, document
// body, note and fixture AI answer the seeded firm shows, in one locale.
// `seed-dev.ts` and its helpers own the structure (ids, timestamps, counts,
// files); a content pack only supplies the words. Each locale's pack is
// total, so a seeded firm never mixes in another language's content.
import type {
  BankAccount,
  BillingAddress,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

import type { ExportReviewCopy } from "../seed-export-review";
import type { MarketingAgentCopy } from "../seed-marketing-agent-thread";
import type { SeedColleague } from "../seed-utils";

type ContactId = SafeId<"contact">;

/** Five fixed slots, addressed by index from matters and parties. */
type Five<T> = readonly [T, T, T, T, T];

export type SeedOrganizationContact = {
  id: ContactId;
  type: "organization";
  displayName: string;
  organizationName: string;
  registrationNumber: string;
  taxId: string;
  bankAccounts?: BankAccount[];
  billingAddress: BillingAddress;
  /** Whole currency units per hour. */
  defaultHourlyRate: number;
  currency: string;
  paymentTermDays: number;
  emails: ContactEmail[];
  phones?: ContactPhone[];
  notes?: string;
  color: string;
};

export type SeedPersonContact = {
  id: ContactId;
  type: "person";
  displayName: string;
  prefix?: string;
  firstName: string;
  lastName: string;
  suffix?: string;
  emails: ContactEmail[];
  phones?: ContactPhone[];
  notes?: string;
  color: string;
};

/**
 * The dev seed's main matters, in seeding order. Ids, the marketing
 * captures and the billing fixtures key on these labels.
 */
export const MAIN_MATTER_LABELS = [
  "ws-akvizice-energo",
  "ws-stavebni-spor",
  "ws-due-diligence",
  "ws-pracovni-spory",
  "ws-compliance-ceska-energie",
  "ws-reorganizace",
  "ws-cross-border",
  "ws-gdpr-audit",
  "ws-export-review",
] as const;

export type MainMatterLabel = (typeof MAIN_MATTER_LABELS)[number];

/** Main matters whose documents a content pack writes by hand. */
export type StandardMatterLabel = Exclude<MainMatterLabel, "ws-export-review">;

export type SeedMatter = {
  name: string;
  /** Org-unique matter number, e.g. "2024/003". */
  reference: string;
  /** Index into `orgContacts`. */
  clientIndex: 0 | 1 | 2 | 3 | 4;
  billingReference?: string;
};

export type SeedExtraMatter = {
  name: string;
  reference: string;
  /** The seedId label of the client contact. */
  clientLabel: string;
};

export type SeedEmailAttachment =
  | { type: "pdf"; fileName: string; title: string; bodyText: string }
  | { type: "text"; fileName: string; bodyText: string };

export type SeedEmail = {
  from: string;
  to: readonly string[];
  cc: readonly string[];
  date: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: readonly SeedEmailAttachment[];
};

export type SupplierAgreementRun =
  | { kind: "deleted"; text: string }
  | { kind: "inserted"; text: string }
  | { kind: "text"; text: string };

export type SupplierAgreementParagraph = {
  /** Margin comment (id in `comments`) anchored to the paragraph. */
  commentId?: number;
  runs: readonly SupplierAgreementRun[];
  style: "body" | "heading" | "title";
};

export const supplierAgreementBody = (
  text: string,
): SupplierAgreementParagraph => ({
  runs: [{ kind: "text", text }],
  style: "body",
});

export const supplierAgreementHeading = (
  text: string,
): SupplierAgreementParagraph => ({
  runs: [{ kind: "text", text }],
  style: "heading",
});

/**
 * The negotiated supplier agreement the editor still films: real tracked
 * changes and margin comments by a seeded colleague.
 */
export type SupplierAgreementContent = {
  fileName: string;
  /** File name of the first version, before the redline. */
  baseFileName: string;
  /** Version labels of the first and the negotiated version. */
  baseVersionLabel: string;
  currentVersionLabel: string;
  /**
   * The draft banner paragraph of the current version, and its text in the
   * first version (which has no tracked changes).
   */
  draftMarker: string;
  baseDraftMarker: string;
  reviewer: { author: string; date: string; initials: string };
  comments: readonly { id: number; text: string }[];
  paragraphs: readonly SupplierAgreementParagraph[];
  /** Status-column note pinned on the agreement. */
  note: string;
};

/** Default document-type keys (apps/api/src/lib/document-types/defaults.ts). */
export type DocumentTypeKey =
  | "nda"
  | "spa"
  | "apa"
  | "shareholders"
  | "msa"
  | "sla"
  | "dpa"
  | "saas"
  | "employment"
  | "consultancy"
  | "lease"
  | "loan"
  | "guarantee"
  | "poa"
  | "license"
  | "distribution"
  | "supply"
  | "settlement"
  | "termsheet"
  | "other";

export const TASK_CODE_KEYS = [
  "RESEARCH",
  "REVIEW",
  "DRAFT",
  "MEETING",
  "COURT",
  "FILING",
  "DISCOVERY",
  "NEGOTIATE",
  "ADVISE",
  "ADMIN",
] as const;

export const ACTIVITY_CODE_KEYS = [
  "PLAN",
  "COMMUNICATE",
  "ANALYZE",
  "MANAGE",
  "TRAVEL",
  "ATTEND",
  "PREPARE",
  "CORRESPOND",
] as const;

export type TaskCodeKey = (typeof TASK_CODE_KEYS)[number];
export type ActivityCodeKey = (typeof ACTIVITY_CODE_KEYS)[number];

/** Template category and template labels (apps/api/scripts/seed-templates.ts). */
export type TemplateCategoryLabel =
  | "tmpl-cat-corporate"
  | "tmpl-cat-employment"
  | "tmpl-cat-commercial"
  | "tmpl-cat-real-estate";

export type TemplateLabel =
  | "tmpl-spa"
  | "tmpl-board-resolution"
  | "tmpl-shareholders"
  | "tmpl-employment"
  | "tmpl-nda"
  | "tmpl-msa"
  | "tmpl-sla"
  | "tmpl-supply"
  | "tmpl-lease";

export type SeedLocaleContent = {
  /**
   * Seeded colleagues of the firm's owner, in author rotation order. The
   * third reviews the supplier agreement.
   */
  colleagues: readonly [SeedColleague, SeedColleague, SeedColleague];
  /** The owner's hourly rate, whole currency units. */
  ownerHourlyRate: number;
  /** Currency of time entries, expenses, invoices and rate tables. */
  currency: string;

  orgContacts: Five<SeedOrganizationContact>;
  personContacts: Five<SeedPersonContact>;
  /** Further clients, for a realistic contacts list. */
  moreOrgContacts: readonly SeedOrganizationContact[];

  matters: Record<MainMatterLabel, SeedMatter>;
  extraMatters: readonly SeedExtraMatter[];
  /**
   * Pinned `lastActivityAt` by matter reference: the newest dates fill the
   * sidebar's recent matters.
   */
  recentMatterActivity: Readonly<Record<string, string>>;

  /** Document names per standard matter, in listing order. */
  matterDocuments: Record<StandardMatterLabel, readonly string[]>;
  /**
   * Body text by document name. The supplier agreement and the email files
   * are generated from their own fields instead.
   */
  documentTexts: Readonly<Record<string, string>>;
  /** Email files by name; each name also appears in `matterDocuments`. */
  emails: Readonly<Record<string, SeedEmail>>;
  /** The share purchase agreement the akvizice matter classifies by type. */
  spaDocumentName: string;
  supplierAgreement: SupplierAgreementContent;

  folders: { documents: string };
  properties: {
    documents: string;
    status: string;
    notes: string;
    dueDate: string;
    documentType: string;
    /** Single-select options: active, in review, closed, on hold. */
    statusOptions: readonly [string, string, string, string];
    documentTypePrompt: string;
  };
  /** Rotating notes on seeded documents. */
  notes: readonly string[];
  documentTypeLabels: Record<DocumentTypeKey, string>;

  exportReview: ExportReviewCopy;
  agent: MarketingAgentCopy;

  billing: {
    taskCodeLabels: Record<TaskCodeKey, string>;
    activityCodeLabels: Record<ActivityCodeKey, string>;
    /** Narratives of the generated time entries. */
    timeEntryNarratives: readonly string[];
    /** Narratives of the sent invoice's six linked entries, in date order. */
    invoiceEntryNarratives: readonly [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    expenseDescriptions: readonly string[];
    rateTableName: string;
    /** Invoice number prefix, e.g. "INV" in "INV-2025-0003". */
    invoiceNumberPrefix: string;
  };
  issuing: {
    seller: {
      legalName: string;
      registrationId: string;
      vatId: string;
      addressLine1: string;
      city: string;
      postalCode: string;
      country: string;
      iban: string;
    };
    vatRates: {
      standard: { name: string; rateBps: number; validFrom: string };
      reduced: { name: string; rateBps: number; validFrom: string };
    };
    numberSeriesName: string;
  };
  templates: {
    categories: Record<
      TemplateCategoryLabel,
      { name: string; description: string }
    >;
    templates: Record<TemplateLabel, { name: string; fileName: string }>;
  };
};
