import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { cents } from "@stll/money";
import {
  BillingPreview,
  ContactsPreview,
  DocumentsPreview,
  MattersPreview,
  ResearchPreview,
  TimeTrackingPreview,
} from "@stll/workspace-ui/feature-previews";
import type {
  BillingPreviewData,
  BillingPreviewLabels,
  ContactsPreviewLabels,
  DocumentsPreviewLabels,
  MattersPreviewData,
  MattersPreviewLabels,
  ResearchPreviewLabels,
  TimeTrackingPreviewLabels,
} from "@stll/workspace-ui/feature-previews";

// Every label is a distinct sentinel, so a render that drops one (a label the
// scene accepts but never draws) shows up as a missing string.
const MATTERS_LABELS = {
  open: "«open»",
  inProgress: "«inProgress»",
  done: "«done»",
} as const satisfies MattersPreviewLabels;

const DOCUMENTS_LABELS = {
  comments: "«comments»",
} as const satisfies DocumentsPreviewLabels;

const RESEARCH_LABELS = {
  caseLaw: "«caseLaw»",
} as const satisfies ResearchPreviewLabels;

const BILLING_LABELS = {
  date: "«date»",
  description: "«description»",
  billedTime: "«billedTime»",
  rate: "«rate»",
  fee: "«fee»",
  summary: "«summary»",
} as const satisfies BillingPreviewLabels;

const CONTACTS_LABELS = {
  businessRegistry: "«businessRegistry»",
  matters: "«matters»",
} as const satisfies ContactsPreviewLabels;

const TIME_TRACKING_LABELS = {
  time: "«time»",
  summary: "«summary»",
} as const satisfies TimeTrackingPreviewLabels;

const SCENES = [
  {
    name: "matters",
    labels: MATTERS_LABELS,
    render: (locale: string) => (
      <MattersPreview labels={MATTERS_LABELS} locale={locale} />
    ),
  },
  {
    name: "documents",
    labels: DOCUMENTS_LABELS,
    render: (locale: string) => (
      <DocumentsPreview labels={DOCUMENTS_LABELS} locale={locale} />
    ),
  },
  {
    name: "research",
    labels: RESEARCH_LABELS,
    render: (locale: string) => (
      <ResearchPreview labels={RESEARCH_LABELS} locale={locale} />
    ),
  },
  {
    name: "billing",
    labels: BILLING_LABELS,
    render: (locale: string) => (
      <BillingPreview labels={BILLING_LABELS} locale={locale} />
    ),
  },
  {
    name: "contacts",
    labels: CONTACTS_LABELS,
    render: (locale: string) => (
      <ContactsPreview labels={CONTACTS_LABELS} locale={locale} />
    ),
  },
  {
    name: "time-tracking",
    labels: TIME_TRACKING_LABELS,
    render: (locale: string) => (
      <TimeTrackingPreview labels={TIME_TRACKING_LABELS} locale={locale} />
    ),
  },
] as const;

const LOCALES = ["en-GB", "cs-CZ", "ar-EG"] as const;

// A raw palette class or colour literal would ignore the host theme; with
// tokens only, `dark` on an ancestor switches every scene with no other input.
const RAW_COLOUR =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|decoration)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b|#[0-9a-f]{3,8}\b|rgba?\(/iu;

// Custom content a host passes in place of the default set.
const CUSTOM_PERSON = { name: "Ada Byron" } as const;

const CUSTOM_MATTER = {
  id: "fixture-matter",
  color: "--option-blue",
  name: "«custom matter»",
} as const;

const CUSTOM_MATTERS = {
  matter: CUSTOM_MATTER,
  team: [CUSTOM_PERSON],
  tasks: [
    {
      name: "«custom task»",
      status: "in_progress",
      due: "2026-11-02",
      assignee: CUSTOM_PERSON,
      attachment: "«custom file».pdf",
    },
  ],
} as const satisfies MattersPreviewData;

const CUSTOM_BILLING = {
  invoiceNumber: "INV-1",
  client: "«custom client»",
  matter: CUSTOM_MATTER,
  currency: "GBP",
  hourlyRate: cents(10_000),
  entries: [
    { date: "2026-11-02", description: "Advice call", billedMinutes: 90 },
  ],
} as const satisfies BillingPreviewData;

describe("feature previews", () => {
  for (const { name, labels, render } of SCENES) {
    for (const locale of LOCALES) {
      test(`${name} renders every label for ${locale}`, () => {
        const markup = renderToStaticMarkup(render(locale));

        expect(markup).toContain('data-slot="feature-preview"');
        expect(markup).toContain('aria-hidden="true"');
        for (const label of Object.values(labels)) {
          expect(markup).toContain(label);
        }
      });
    }

    test(`${name} draws only with theme tokens, so light and dark follow the host`, () => {
      const markup = renderToStaticMarkup(render("en-GB"));

      expect(markup).not.toMatch(RAW_COLOUR);
    });
  }

  test("billing totals the entries with the app's money helpers", () => {
    const markup = renderToStaticMarkup(
      <BillingPreview labels={BILLING_LABELS} locale="en-GB" />,
    );

    // 594 billed minutes at EUR 220 an hour.
    expect(markup).toContain("9.9");
    expect(markup).toContain("€2,178.00");
  });

  test("a scene draws the content its host passes instead of the default", () => {
    const markup = renderToStaticMarkup(
      <MattersPreview
        data={CUSTOM_MATTERS}
        labels={MATTERS_LABELS}
        locale="en-GB"
      />,
    );

    expect(markup).toContain("«custom matter»");
    expect(markup).toContain("«custom task»");
    expect(markup).toContain("«custom file».pdf");
    expect(markup).not.toContain("Harbour Logistics");
  });

  test("billing totals custom entries at their own rate and currency", () => {
    const markup = renderToStaticMarkup(
      <BillingPreview
        data={CUSTOM_BILLING}
        labels={BILLING_LABELS}
        locale="en-GB"
      />,
    );

    // 90 billed minutes at GBP 100 an hour.
    expect(markup).toContain("«custom client»");
    expect(markup).toContain("1.5");
    expect(markup).toContain("£150.00");
  });
});
