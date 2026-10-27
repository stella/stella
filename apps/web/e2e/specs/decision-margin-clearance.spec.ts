import type { Locator, Page } from "@playwright/test";

import type { OrganizationAIAvailability } from "@stll/api-contract/organization-ai-availability";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { READER_ASIDE_RESIZE_SLOT } from "../../src/features/case-law/components/case-viewer/reader-aside-slots";
import ar from "../../src/i18n/langs/ar.json" with { type: "json" };
import en from "../../src/i18n/langs/en.json" with { type: "json" };
import { E2E_API_ORIGIN } from "../helpers/api";
import {
  DECISION_READER_BOOT_PATH,
  openMemberDecision,
} from "../helpers/decision-reader";
import {
  DOCKED_CHAT_LEGAL_ROUTES,
  installDockedLegalFixtures,
} from "../helpers/docked-chat-legal-fixtures";
import { dockedChatLegalPayloads } from "../helpers/docked-chat-legal-payloads";
import { expect, test } from "../helpers/test";

const SECTION_COUNT = 6;
const PARAGRAPHS_PER_SECTION = 3;
const TOPICS = [
  "zastoupení advokátem v řízení",
  "odmítnutí návrhu",
  "výzva k odstranění vad návrhu",
  "ústavní stížnost",
  "zrušení soudního rozhodnutí",
  "opakované podání",
  "poučení navrhovatele",
] as const;
const paragraphText = "Soud posoudil podmínky řízení a předložené listiny. ";

const paragraphId = (section: number, paragraph: number) =>
  `paragraph-${String(section)}-${String(paragraph)}`;
const firstParagraph = paragraphId(0, 0);
const sections = Array.from({ length: SECTION_COUNT }, (_, section) => ({
  heading: `heading-${String(section)}`,
  title: `Oddíl ${String(section + 1)}`,
  start: paragraphId(section, 0),
  end: paragraphId(section, PARAGRAPHS_PER_SECTION - 1),
  paragraphs: Array.from(
    { length: PARAGRAPHS_PER_SECTION },
    (_slot, paragraph) => paragraphId(section, paragraph),
  ),
}));

const ast = {
  version: 1,
  source: {
    system: "synthetic",
    documentId: "margin-clearance",
    webUrl: "",
    printUrl: "",
  },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks: sections.flatMap(({ heading, title, paragraphs }) => [
    {
      id: heading,
      anchorId: heading,
      type: "heading" as const,
      level: 1,
      inlines: [{ type: "text" as const, text: title }],
      plainText: title,
    },
    ...paragraphs.map((anchorId) => ({
      id: anchorId,
      anchorId,
      type: "paragraph" as const,
      inlines: [{ type: "text" as const, text: paragraphText.repeat(12) }],
      plainText: paragraphText.repeat(12),
    })),
  ]),
} satisfies DocumentAst;

const analysis = {
  version: 4,
  generatedAt: "2026-10-06T08:00:00.000Z",
  model: "synthetic",
  inputFingerprint: "f".repeat(64),
  holding: {
    spans: [
      {
        text: "Návrh trpící vadami lze odmítnout.",
        anchors: [
          { startAnchorId: firstParagraph, endAnchorId: firstParagraph },
        ],
      },
    ],
    language: "cs",
  },
  abstract: {
    spans: [
      {
        text: "Soud návrh odmítl pro neodstranitelné vady.",
        anchors: [
          { startAnchorId: firstParagraph, endAnchorId: firstParagraph },
        ],
      },
    ],
    language: "cs",
  },
  topics: [...TOPICS],
  tree: sections.map(({ end, paragraphs, start, title }, section) => ({
    id: `analysis-${String(section)}`,
    label: `Podmínky řízení ${title}`,
    category: "reasoning",
    startAnchorId: start,
    endAnchorId: end,
    annotations: paragraphs.map((anchorId) => ({
      id: `note-${anchorId}`,
      summary: `Odmítnutí bez výzvy k odstranění vad (${anchorId}).`,
      startAnchorId: anchorId,
      endAnchorId: anchorId,
      textSnippet: paragraphText,
    })),
    children: [],
  })),
} satisfies DecisionAnalysis;

const decision = { ...dockedChatLegalPayloads.decision, documentAst: ast };

const openDecision = async (page: Page) => {
  await installDockedLegalFixtures(page);
  await page.route(
    (url) =>
      url.origin === E2E_API_ORIGIN &&
      [
        `/v1/case/decisions/${decision.id}`,
        `/v1/case/decisions/by-slug/${decision.slug}`,
        `/v1/case/decisions/${decision.id}/analysis`,
        "/v1/organization-settings/ai-availability",
      ].includes(url.pathname),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.endsWith("/analysis")) {
        await route.fulfill({
          json: {
            status: "done",
            analysis,
          } satisfies { status: "done"; analysis: DecisionAnalysis },
        });
        return;
      }
      if (pathname === "/v1/organization-settings/ai-availability") {
        await route.fulfill({
          json: {
            available: true,
            instanceProvisioned: true,
            orgConfigured: false,
            unavailableReason: null,
            providerConfiguration: "allowed",
            deferredServiceTierAvailable: false,
            mockAnswers: false,
          } satisfies OrganizationAIAvailability,
        });
        return;
      }
      await route.fulfill({ json: decision });
    },
  );
  await openMemberDecision(page, {
    bootPath: DECISION_READER_BOOT_PATH,
    path: DOCKED_CHAT_LEGAL_ROUTES.decision.path,
  });
};

/** The floating row that holds the heading trail and the zoom triad. */
const controlsBar = (page: Page) =>
  page.locator('[data-slot="reader-breadcrumb"]').locator("..");

const notesColumn = (page: Page) =>
  page.locator("aside[data-reader-notes-column]");

type Box = { x: number; y: number; width: number; height: number };

const box = async (locator: Locator): Promise<Box> => {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds ?? { x: 0, y: 0, width: 0, height: 0 };
};

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** Every margin note painted at least partly inside the reader's viewport. */
const visibleNoteBoxes = async (page: Page): Promise<Box[]> =>
  await page
    .locator('[data-slot="reader-document-column"]')
    .evaluate((column) => {
      const scroller = column.closest(".reader-scroll");
      if (scroller === null) {
        throw new Error("Reader scroller not found");
      }
      const frame = scroller.getBoundingClientRect();
      return [
        ...document.querySelectorAll(
          "aside[data-reader-notes-column] [data-margin-note] > *",
        ),
      ]
        .map((note) => note.getBoundingClientRect())
        .filter(
          (rect) =>
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > frame.top &&
            rect.top < frame.bottom,
        )
        .toSorted((left, right) => left.top - right.top)
        .map(({ x, y, width, height }) => ({ x, y, width, height }));
    });

const WIDE_CASES = [
  { locale: "en-US", dir: "ltr", messages: en },
  { locale: "ar", dir: "rtl", messages: ar },
] as const;

const VIEWPORT_HEIGHT = 900;

for (const { locale, dir, messages } of WIDE_CASES) {
  test.describe(`decision reader margin at lg (${dir})`, () => {
    test.use({ locale, viewport: { width: 1440, height: VIEWPORT_HEIGHT } });

    test("no floating reader chrome covers the notes column", async ({
      page,
    }) => {
      await openDecision(page);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      const aside = notesColumn(page);
      const firstTopic = aside.getByText(TOPICS[0], { exact: true });
      await expect(firstTopic).toBeVisible();
      await expect(aside.locator("[data-margin-note]").first()).toBeAttached();

      // At the top of the scroll the topics sit at the top of the margin.
      const bar = controlsBar(page);
      const topics = firstTopic.locator("xpath=ancestor::section[1]");
      expect(intersects(await box(bar), await box(topics))).toBe(false);
      expect(intersects(await box(bar), await box(aside))).toBe(false);

      // The outline opens over the text the bar belongs to.
      const contents = bar.getByRole("button", {
        name: messages.statutes.outline,
        exact: true,
      });
      await contents.click();
      const popup = page
        .locator('[data-slot="popover-positioner"]')
        .filter({ has: page.locator("[data-contents-anchor]") });
      await expect(popup).toBeVisible();
      expect(intersects(await box(popup), await box(aside))).toBe(false);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);

      // Scrolled into the text, the margin's own section header shows and the
      // notes beside the text keep clear of the bar.
      const frame = await box(
        page.locator(".reader-scroll", {
          has: page.locator('[data-slot="reader-document-column"]'),
        }),
      );
      await page.mouse.move(
        frame.x + frame.width / 2,
        frame.y + frame.height / 2,
      );
      await page.mouse.wheel(0, 1800);
      const currentSection = aside.getByTitle(
        messages.caseLaw.analysis.backToSection,
      );
      // The header stays mounted at zero opacity until a heading has passed
      // the top, so its own visibility flag is what says it shows.
      await expect(currentSection.locator("..")).toHaveAttribute(
        "aria-hidden",
        "false",
      );
      const barBox = await box(bar);
      expect(intersects(barBox, await box(currentSection))).toBe(false);
      expect(intersects(barBox, await box(aside))).toBe(false);
      const notes = await visibleNoteBoxes(page);
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) {
        expect(intersects(barBox, note)).toBe(false);
      }
    });

    test("the bar follows the notes column as it is resized", async ({
      page,
    }) => {
      await openDecision(page);
      const aside = notesColumn(page);
      await expect(aside.getByText(TOPICS[0], { exact: true })).toBeVisible();
      const before = await box(aside);
      const handle = await box(
        aside.locator(`[data-slot="${READER_ASIDE_RESIZE_SLOT}"]`),
      );
      // Toward the column's inline end widens it, in either direction.
      const towardEnd = dir === "rtl" ? -40 : 40;
      // The handle runs the column's full height, past the viewport; grab it
      // inside the visible part, where the pointer can reach it.
      const visibleTop = Math.max(handle.y, 0);
      const visibleBottom = Math.min(handle.y + handle.height, VIEWPORT_HEIGHT);
      const y = (visibleTop + visibleBottom) / 2;
      await page.mouse.move(handle.x + handle.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + towardEnd, y, {
        steps: 4,
      });
      await page.mouse.up();
      // The grab point sits a few pixels inside the column's edge.
      await expect
        .poll(async () => (await box(aside)).width)
        .toBeGreaterThan(before.width + 30);
      expect(intersects(await box(controlsBar(page)), await box(aside))).toBe(
        false,
      );
    });
  });
}

test.describe("decision reader margin below lg", () => {
  test.use({ locale: "en-US", viewport: { width: 900, height: 900 } });

  test("the bar keeps its own inset when no notes column is drawn", async ({
    page,
  }) => {
    await openDecision(page);
    await expect(notesColumn(page)).toBeHidden();
    const bar = controlsBar(page);
    await expect(bar).toBeVisible();
    const inset = await bar.evaluate((element) => {
      const layout = element.parentElement;
      if (layout === null) {
        throw new Error("Reader layout not found");
      }
      return (
        element.getBoundingClientRect().left -
        layout.getBoundingClientRect().left
      );
    });
    expect(inset).toBeCloseTo(8, 0);
  });
});
