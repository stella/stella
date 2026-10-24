import { describe, expect, test } from "bun:test";

import { compareByLocale } from "@stll/collation";
import {
  MARKETING_LOCALE_MARKERS,
  MARKETING_LOCALES,
} from "@stll/playwright-tools/marketing-locales";

import { DEFAULT_DOCUMENT_TYPES } from "@/api/lib/document-types/defaults";

import { SEED_CONTENT_BY_LOCALE } from "./locales";

// What the localized captures wait on and frame must be what each firm's
// pack seeds; a pack drifting from the shared markers would otherwise only
// fail in the screenshot run.
describe.each(MARKETING_LOCALES)("seed content (%s)", (locale) => {
  const content = SEED_CONTENT_BY_LOCALE[locale];
  const markers = MARKETING_LOCALE_MARKERS[locale];

  test("names the filmed matters, documents and invoice like the capture markers", () => {
    expect(content.matters["ws-akvizice-energo"].name).toBe(
      markers.meridianMatterName,
    );
    expect(content.matters["ws-export-review"].name).toBe(
      markers.exportReviewMatterName,
    );
    expect(content.supplierAgreement.fileName).toBe(
      markers.supplierAgreementFileName,
    );
    // The capture opens these by their seeded position in the matter
    // (apps/web/e2e/marketing/seed-ids.ts).
    const meridianDocuments = content.matterDocuments["ws-akvizice-energo"];
    expect(meridianDocuments.at(0)).toBe(content.spaDocumentName);
    expect(meridianDocuments.at(4)).toBe(markers.safeAgreementFileName);
    expect(meridianDocuments.at(5)).toBe(markers.redactedExtractFileName);
    expect(meridianDocuments.at(6)).toBe(markers.supplierAgreementFileName);
    expect(`${content.billing.invoiceNumberPrefix}-2025-0003`).toBe(
      markers.sentInvoiceNumber,
    );
  });

  test("heads the contacts list with the marker contact", () => {
    const names = [
      ...content.orgContacts,
      ...content.personContacts,
      ...content.moreOrgContacts,
    ].map(({ displayName }) => displayName);
    expect(names.toSorted(compareByLocale("en")).at(0)).toBe(
      markers.firstContactName,
    );
  });

  test("gives every listed document a body", () => {
    const generated = new Set([
      content.supplierAgreement.fileName,
      ...Object.keys(content.emails),
    ]);
    const listed = Object.values(content.matterDocuments).flat();
    for (const name of listed) {
      if (!generated.has(name)) {
        expect(content.documentTexts[name], name).toBeString();
      }
    }
    for (const name of Object.keys(content.emails)) {
      expect(listed).toContain(name);
    }
    expect(new Set(listed).size).toBe(listed.length);
  });

  test("keeps file names to ASCII", () => {
    const names = [
      ...Object.values(content.matterDocuments).flat(),
      content.supplierAgreement.baseFileName,
      ...Object.values(content.templates.templates).map(
        ({ fileName }) => fileName,
      ),
    ];
    for (const name of names) {
      expect(name).toMatch(/^[\w.-]+$/u);
    }
  });

  test("labels exactly the default document types", () => {
    expect(Object.keys(content.documentTypeLabels).toSorted()).toEqual(
      DEFAULT_DOCUMENT_TYPES.map(({ key }) => key).toSorted(),
    );
  });

  test("keeps the supplier agreement's two tracked deviations", () => {
    const { comments, draftMarker, paragraphs } = content.supplierAgreement;
    const runs = paragraphs.flatMap((paragraph) => paragraph.runs);
    expect(runs.some(({ kind }) => kind === "deleted")).toBe(true);
    expect(runs.some(({ kind }) => kind === "inserted")).toBe(true);
    expect(runs.map(({ text }) => text)).toContain(draftMarker);
    expect(
      paragraphs
        .flatMap(({ commentId }) =>
          commentId === undefined ? [] : [commentId],
        )
        .toSorted((left, right) => left - right),
    ).toEqual(
      comments.map(({ id }) => id).toSorted((left, right) => left - right),
    );
  });

  test("keeps the review extract's sentences on one line", () => {
    const { extract } = content.exportReview;
    const row = {
      counterparty: content.exportReview.counterparties[0],
      documentType: content.exportReview.documentTypes[0],
      jurisdiction: content.exportReview.jurisdictions[0],
      governingLaw: content.exportReview.governingLaws[0],
    };
    for (const line of [
      extract.heading(row.documentType),
      extract.intro(row),
      extract.clause(row),
      content.exportReview.keyObligation(row.counterparty),
    ]) {
      expect(line).not.toContain("\n");
    }
  });
});
