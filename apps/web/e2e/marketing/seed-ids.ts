// The seeded rows the marketing captures open, per locale firm. The dev seed
// derives every id from a label and its firm's namespace
// (apps/api/scripts/seed-utils.ts `seedId`); this derives the same ids from
// the same shared formula instead of copying UUIDs.
import {
  formatSeedUuid,
  marketingSeedNamespace,
  seedIdHashInput,
} from "@stll/playwright-tools/marketing-locales";
import type { MarketingLocale } from "@stll/playwright-tools/marketing-locales";
import { sha256Hex } from "@stll/sha256/node";

const marketingSeedId = (locale: MarketingLocale, label: string): string =>
  formatSeedUuid(
    sha256Hex(seedIdHashInput(marketingSeedNamespace(locale), label)),
  );

/**
 * Ids in the Meridian matter (`ws-akvizice-energo`): documents are numbered
 * from 1, their file fields from 0, in the matter's listing order.
 */
export const marketingSeedIds = (locale: MarketingLocale) => {
  const id = (label: string) => marketingSeedId(locale, label);
  return {
    meridianWorkspaceId: id("ws-akvizice-energo"),
    exportReviewWorkspaceId: id("ws-export-review"),
    dueDiligenceWorkspaceId: id("ws-due-diligence"),
    // INV-2025-0003 and its localized numbers: the sent invoice whose billed
    // time entries the invoicing capture lists.
    sentInvoiceId: id("invoice-2"),
    // The anonymized due-diligence extract, sixth in the Meridian matter.
    anonymizedExtract: {
      entityId: id("ws-akvizice-energo-doc-6"),
      fieldId: id("ws-akvizice-energo-field-file-5"),
    },
    // The negotiated supplier agreement, seventh; the matter's file property
    // keys its edit lock with the entity.
    supplierAgreement: {
      workspaceId: id("ws-akvizice-energo"),
      entityId: id("ws-akvizice-energo-doc-7"),
      fieldId: id("ws-akvizice-energo-field-file-6"),
      propertyId: id("ws-akvizice-energo-prop-file"),
    },
  };
};

export type SupplierAgreementIds = ReturnType<
  typeof marketingSeedIds
>["supplierAgreement"];
