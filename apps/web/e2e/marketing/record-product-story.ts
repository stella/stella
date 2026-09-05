// The e2e tsconfig is node-only (lib ESNext); the `page.evaluate` /
// `addInitScript` callbacks below run in the browser, so pull in the DOM
// lib for their globals (document, localStorage, MutationObserver, ...).
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { chromium } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  CAPTURE_DPR,
  CAPTURE_THEMES,
  captureDefinitions,
  RECORDINGS_MANIFEST_PATH,
} from "./captures";
import type {
  CaptureDefinition,
  CaptureTheme,
  CaptureViewport,
  RecordingManifestEntry,
  RecordingsManifest,
  StoryCaptureId,
} from "./captures";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MEDIA_DIR = path.join(REPO_ROOT, "apps/landing/public/media/products");
const RAW_VIDEO_DIR = path.join(REPO_ROOT, ".playwright/marketing-video");
const WEB_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const API_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const CAPTURE_FILTER = process.env["MARKETING_CAPTURE"];
const THEME_FILTER = process.env["MARKETING_THEME"];
const EMAIL = "test@stella.dev";
const MARKETING_ORGANIZATION_NAME = "Harbrook & Partners";
const MARKETING_AGENT_THREAD_TITLE = "Project Atlas · Change-of-control review";
const EXPORT_REVIEW_WORKSPACE_ID = "bb8641dc-0667-574c-8e30-152a1fd4b3f5";
const MERIDIAN_WORKSPACE_ID = "6cbf3f81-bcc9-55da-8a4e-840221d4cabe";
// The negotiated Supplier Agreement in the "Meridian supply agreement"
// matter (seed-dev.ts: `ws-akvizice-energo-doc-7` /
// `ws-akvizice-energo-field-file-6`): the docx with the clause-12
// liability-cap redline and playbook margin comments that the editor scenes
// film, matching the landing DOM mock (storyEditorDocument in
// apps/landing/src/data/product-story.ts).
const SUPPLIER_AGREEMENT_ENTITY_ID = "84824638-eb81-58c5-8a81-5d7e961fb7d5";
const SUPPLIER_AGREEMENT_FIELD_ID = "3f985a8b-26be-5a07-89d3-2a05acb94354";
const SUPPLIER_AGREEMENT_FILE_NAME = "Supplier_Agreement.docx";
// The wide/hero/portrait viewports and the capture matrix live in
// ./captures.ts so the staleness check (scripts/check-marketing-recordings.ts)
// shares one source of truth with the recorder.
const NAV_VIEWPORT = { height: 720, width: 1280 } as const;
const MANIFEST_PATH = path.join(REPO_ROOT, RECORDINGS_MANIFEST_PATH);
// eslint-disable-next-line typescript/strict-void-return -- promisify resolves execFile via its custom `__promisify__` overload; the rule matches the generic void-callback overload instead
const execFileAsync = promisify(execFile);

// Whether the fake cursor overlay is injected for a scene. "visible" scenes
// must end their prepare step at the scene's deliberate resting pointer
// position: the ready reference screenshot (and therefore frame 0 and the
// poster) includes the cursor, and the loop choreography must return to that
// same rest point so the loop still closes.
type CursorMode = "hidden" | "visible";

type StoryScene = {
  // Pre-collapse the app sidebar (icon rail) before the page loads; used by
  // the portrait document scene so the docx page fills the frame.
  collapsedSidebar?: boolean;
  cursor: CursorMode;
  durationSeconds: number;
  id: StoryCaptureId;
  path: (views: MarketingViewRoutes) => string;
  prepare: (page: Page) => Promise<void>;
};

// One scene can be captured at several viewports; `captureId` names the
// output files (story-<captureId>[-dark].mp4) and is what MARKETING_CAPTURE
// (comma-separated) filters on.
type StoryCapture = StoryScene & CaptureDefinition;

type MarketingViewRoutes = {
  agent: string;
  files: string;
  table: string;
  // Filesystem view of the Meridian workspace (MERIDIAN_WORKSPACE_ID): the
  // template-fill scene's "Add" menu (New document from template) only
  // lives there, not in the Table view's upload-only bottom row.
  templateFillFiles: string;
};

// The clause-12 redline as painted on the page. Scoped to the painted layout
// layer (`.layout-run-text`): once the edit session unlocks, folio also
// mirrors the document into a hidden off-screen ProseMirror layer whose runs
// carry `.docx-insertion` too, and scrolling that mirror moves nothing.
const PAINTED_REDLINE_SELECTOR = ".layout-run-text.docx-insertion";

// Folio's painted template-directive overlays in the template studio: the
// {{...}} field placeholders, the {{#if}} conditional-section markers, and
// the {{@clause:...}} slots. The templates scene requires the first two
// before the ready marker and scrolls to the last clause slot mid-loop.
const TEMPLATE_FIELD_SELECTOR = ".folio-template-directive--placeholder";
const TEMPLATE_CONDITIONAL_SELECTOR = ".folio-template-directive--if";
const TEMPLATE_CLAUSE_SELECTOR = ".folio-template-directive--clause";

// Shared prepare for both editor scenes: wait for the Supplier Agreement to
// lay out, require the clause-12 redline (folio's tracked-insertion run) so
// a build that lost the tracked change can never ship a clean-document
// recording, then close the inspector so the page fills the frame.
const prepareEditorScene = async (page: Page) => {
  await page.getByText(SUPPLIER_AGREEMENT_FILE_NAME).first().waitFor();
  await page.locator(".layout-run-text").first().waitFor();
  await page.locator(PAINTED_REDLINE_SELECTOR).first().waitFor();
  await closeInspectorIfOpen(page);
};

// ─── Agent-scene inspector preview guards ───────────────
// The agent loop clicks cited-source chips mid-cut, which opens the
// right-hand inspector with the document's folio preview. That preview
// loads asynchronously (file download + docx layout), so on a cold cache
// the pane can sit as a large blank white column for a chunk of the cut;
// the first-frame PSNR check is structurally blind to it because frame 0
// has the pane closed and the reference screenshot is taken at the same
// moment as the frame it validates. The guards are therefore DOM-level
// and post-marker: prepare pre-warms both cited documents (which also
// fails the run early if a preview cannot render at all), and the replay
// enforces a per-click paint budget so slow-loading footage is a
// recording failure, never a shipped clip.
const MIN_INSPECTOR_PREVIEW_TEXT_LENGTH = 200;
const INSPECTOR_PREVIEW_PAINT_BUDGET_MS = 1500;
const INSPECTOR_PREWARM_TIMEOUT_MS = 60_000;

type InspectorPreviewMarker = {
  // Substring of the document body text that must appear inside the
  // painted folio runs, so tab switches cannot pass with the previous
  // document's paint.
  bodyMarker: string;
  label: string;
};

// Painted-text predicate evaluated in the page: real rendered document
// text, not a skeleton. `.layout-run-text` is folio's painted layout
// layer (docx previews) and `[data-text-layer]` is the pdf.js text layer
// (pdf previews, appended only after the page has rendered); the chat
// column paints neither, so on this route the selectors can only match
// the inspector preview. The doc-specific bodyMarker keeps a tab switch
// from passing on the previous document's still-mounted paint.
const inspectorPreviewIsPainted = ({
  bodyMarker,
  minLength,
}: {
  bodyMarker: string;
  minLength: number;
}) => {
  const painted = [
    ...document.querySelectorAll(".layout-run-text, [data-text-layer]"),
  ]
    .map((run) => run.textContent)
    .join("");
  return painted.trim().length >= minLength && painted.includes(bodyMarker);
};

const waitForInspectorPreview = async (
  page: Page,
  marker: InspectorPreviewMarker,
  timeoutMs: number,
) => {
  try {
    await page.waitForFunction(
      inspectorPreviewIsPainted,
      {
        bodyMarker: marker.bodyMarker,
        minLength: MIN_INSPECTOR_PREVIEW_TEXT_LENGTH,
      },
      { timeout: timeoutMs },
    );
  } catch {
    throw new Error(
      `agent: the inspector preview for ${marker.label} did not paint ` +
        `within ${timeoutMs}ms; refusing to ship footage with a blank ` +
        "inspector pane",
    );
  }
};

const FIRST_SOURCE_PREVIEW = {
  bodyMarker: "Aurora_Retail_Shareholder_Register_2018",
  label: "Aurora_Retail_Shareholder_Register_2018",
} as const satisfies InspectorPreviewMarker;
const SECOND_SOURCE_PREVIEW = {
  bodyMarker: "Edison_Bank_Permit_2018",
  label: "Edison_Bank_Permit_2018",
} as const satisfies InspectorPreviewMarker;

// ─── Review-citation scene: cell-to-passage click-through ───────────────
// The Export Review table's Governing Law column for the seeded
// Aurora_Retail_Shareholder_Register_2018.docx row (seed-dev.ts row index 0:
// a "Direct citation" evidence-quality DOCX). Its citation quote
// ("Governing law: Netherlands") is a verbatim line in the seeded document
// body, and seed-dev.ts's ExportReviewCitationSeed.blockIndex points the
// citation at that exact paragraph, so opening it resolves to a real
// folio exact-passage highlight (PR #1215) instead of a degraded block
// flash — required for this scene to ever have something to hold on.
const EXPORT_REVIEW_GOVERNING_LAW_QUOTE = "Governing law: Netherlands";

// AICellSourceCard's own PreviewCardTrigger hover delay is 650ms; a plain
// click on the cell instead enters row-cells.tsx's cell-expansion mode
// (data-expanded-cell) and, via the trigger's own onPointerDown dismiss
// guard, actively prevents this same popover from opening — so the cell
// must be hovered, never clicked, for the popover to appear.
const CITATION_POPOVER_HOVER_DELAY_MS = 850;
const CITATION_POPOVER_CONTENT_SELECTOR = '[data-slot="preview-card-content"]';

// Resolves the Governing Law column's grid cell for the Aurora row by
// correlating the column header's aria-colindex with the row's own
// gridcells (the table has no direct header/column id association in the
// DOM), then scrolls it into view: at 1280px wide the table's ~17 columns
// overflow far past the viewport, and Governing Law sits well off-screen
// by default.
const locateExportReviewGoverningLawCell = async (
  page: Page,
): Promise<Locator> => {
  const columnIndex = await page
    .getByRole("columnheader", { name: "Governing Law" })
    .first()
    .getAttribute("aria-colindex");
  if (!columnIndex) {
    throw new Error(
      "review-citation: could not resolve the Governing Law column index",
    );
  }
  const row = page
    .getByRole("row")
    .filter({ hasText: /Aurora_Retail_Shareholder_Register_2018/u })
    .first();
  const cell = row.locator(`[role="gridcell"][aria-colindex="${columnIndex}"]`);
  await cell.scrollIntoViewIfNeeded();
  return cell;
};

// Hover the citation cell long enough for the AICellSourceCard popover to
// open (showing the citation quote), then click through it: the popover's
// whole content is a button wrapping the same onOpen() the cell's inline
// Preview action calls, so this opens the source document with the
// citation's justification active.
const openGoverningLawCitationPopover = async (page: Page, cell: Locator) => {
  await hoverWithCursor(page, cell);
  await page.waitForTimeout(CITATION_POPOVER_HOVER_DELAY_MS);
  await clickWithCursor(
    page,
    page.locator(`${CITATION_POPOVER_CONTENT_SELECTOR} button`).first(),
  );
};

// Painted DOCX body text plus folio's exact-passage highlight overlay
// (`.folio-passage-highlight`, only painted when the passage text match
// succeeds — see PassageHighlightOverlay in @stll/folio-react). Requiring
// both means a build that lost either the folio preview or the
// exact-passage highlight itself can never ship this scene's footage.
const passageHighlightIsPainted = ({
  bodyMarker,
  minLength,
}: {
  bodyMarker: string;
  minLength: number;
}) => {
  const painted = [
    ...document.querySelectorAll(".layout-run-text, [data-text-layer]"),
  ]
    .map((run) => run.textContent)
    .join("");
  if (painted.trim().length < minLength || !painted.includes(bodyMarker)) {
    return false;
  }
  return [...document.querySelectorAll(".folio-passage-highlight")].some(
    (highlight) => {
      const rect = highlight.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
  );
};

const GOVERNING_LAW_CITATION_MARKER = {
  bodyMarker: EXPORT_REVIEW_GOVERNING_LAW_QUOTE,
  label: "Governing Law citation (Aurora_Retail_Shareholder_Register_2018)",
} as const satisfies InspectorPreviewMarker;

const waitForPassageHighlight = async (
  page: Page,
  marker: InspectorPreviewMarker,
  timeoutMs: number,
) => {
  try {
    await page.waitForFunction(
      passageHighlightIsPainted,
      {
        bodyMarker: marker.bodyMarker,
        minLength: MIN_INSPECTOR_PREVIEW_TEXT_LENGTH,
      },
      { timeout: timeoutMs },
    );
  } catch {
    throw new Error(
      `review-citation: the exact-passage highlight for ${marker.label} did ` +
        `not paint within ${timeoutMs}ms; refusing to ship footage with an ` +
        "unhighlighted citation",
    );
  }
};

// ─── Template-fill scene: AI-assisted prefill from a matter's documents ──
// "New document from template" inside the Meridian workspace, filling the
// seeded Supply Agreement (tmpl-supply, seed-templates.ts) from that same
// matter's own Supplier_Agreement.docx via the "Prefill from documents"
// panel — the templates product page's H1 ("let AI fill them in") claim,
// filmed for the first time. Every value this paints comes from the
// tmpl-supply fixture in apps/api/src/dev/register-mock-ai.ts, frozen from a
// real extraction hand-verified against the seeded document; it is not a
// live model call (see that file's comment before touching either).
const TEMPLATE_FILL_TEMPLATE_LABEL = "Supply Agreement";
const TEMPLATE_FILL_SOURCE_DOCUMENT = "Supplier_Agreement.docx";
const TEMPLATE_FILL_PREFILL_TOGGLE_LABEL = "Prefill from documents";
const TEMPLATE_FILL_PREFILL_RUN_LABEL = "Prefill";
const TEMPLATE_FILL_CUSTOMER_NAME_SELECTOR = 'textarea[name="customerName"]';
const TEMPLATE_FILL_EXPECTED_CUSTOMER_NAME = "Northstar Robotics, Inc.";

// Opens the dialog fresh: "Add" (the file tree's own add menu, not the
// Table view's upload-only bottom row) -> "New document from template" ->
// the seeded Supply Agreement. NewDocumentFromTemplateDialog only mounts its
// body while open, so every open starts at a pristine template picker.
// Three elements answer to the accessible name "Add" on this view: the view
// switcher's own "Add view" trigger, the sort toolbar's "Add sort" trigger,
// and the tree view's (filesystem/tree-view.tsx) real AddEntityMenu button —
// plus a fourth, `sr-only` AddEntityMenu trigger the tree view renders purely
// as a right-click context-menu anchor. The three decoys all set an explicit
// `aria-label="Add"` (they have no visible text of their own); only the real
// tree button gets its accessible name from rendered text content
// (`<PlusIcon/>{t("common.add")}`, add-entity-menu.tsx), so excluding
// anything with an `aria-label` lands on it uniquely.
const templateFillAddButton = (page: Page) =>
  page
    .getByRole("button", { name: "Add", exact: true })
    .and(page.locator(":not([aria-label])"));

const openTemplateFillDialog = async (page: Page) => {
  await clickWithCursor(page, templateFillAddButton(page));
  await clickWithCursor(
    page,
    page.getByRole("menuitem", { name: "New document from template" }),
  );
  // Not `exact: true`: the row's accessible name concatenates the template
  // name with its (unhidden) field-count span, e.g. "Supply Agreement 16
  // fields", so match on the name as a leading substring instead.
  await clickWithCursor(
    page,
    page.getByRole("button", {
      name: new RegExp(`^${TEMPLATE_FILL_TEMPLATE_LABEL}\\b`, "u"),
    }),
  );
  await page
    .getByRole("button", { name: TEMPLATE_FILL_PREFILL_TOGGLE_LABEL })
    .waitFor();
};

const closeTemplateFillDialog = async (page: Page) => {
  await page
    .getByRole("button", { name: /^close$/iu })
    .last()
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
};

// Expand the panel, pick the matter's own Supplier_Agreement.docx (scrolled
// into view: it is the last of 7 documents in a fixed-height scrollable
// checklist), and run the prefill. Shared by the prewarm and the on-camera
// replay, exactly like the review-citation popover open.
const runTemplateFillPrefill = async (page: Page) => {
  await clickWithCursor(
    page,
    page.getByRole("button", { name: TEMPLATE_FILL_PREFILL_TOGGLE_LABEL }),
  );
  const sourceCheckbox = page.getByRole("checkbox", {
    name: TEMPLATE_FILL_SOURCE_DOCUMENT,
  });
  await sourceCheckbox.scrollIntoViewIfNeeded();
  await clickWithCursor(page, sourceCheckbox);
  await clickWithCursor(
    page,
    page.getByRole("button", {
      name: TEMPLATE_FILL_PREFILL_RUN_LABEL,
      exact: true,
    }),
  );
};

// Painted-value predicate: the Customer Name field (a plain `<textarea
// name="customerName">`, see template-form.tsx) actually holds the fixture's
// known value, not a loading/blank state. Requiring the real value (rather
// than e.g. a toast) means a build that lost the fixture, or reverted to a
// live/broken model path, can never ship this scene's footage.
const templateFillCustomerNameIsPainted = ({
  selector,
  expected,
}: {
  expected: string;
  selector: string;
}) => {
  const field = document.querySelector(selector);
  return field instanceof HTMLTextAreaElement && field.value === expected;
};

const waitForTemplateFillPaint = async (page: Page, timeoutMs: number) => {
  try {
    await page.waitForFunction(
      templateFillCustomerNameIsPainted,
      {
        selector: TEMPLATE_FILL_CUSTOMER_NAME_SELECTOR,
        expected: TEMPLATE_FILL_EXPECTED_CUSTOMER_NAME,
      },
      { timeout: timeoutMs },
    );
  } catch {
    throw new Error(
      "template-fill: the prefilled Customer Name did not paint within " +
        `${timeoutMs}ms; refusing to ship footage with an unfilled form`,
    );
  }
};

const scenes = [
  {
    id: "workspace",
    cursor: "visible",
    path: ({ files }) => files,
    durationSeconds: 3.5,
    prepare: async (page) => {
      await page
        .getByText("Export Review - Project Atlas Data Room")
        .first()
        .waitFor();
      await page
        .getByText(/Aurora_Retail_Shareholder_Register_2018/u)
        .first()
        .waitFor();
      // Rest: the second (home) row, matching the frame-0 hover state the
      // loop returns to.
      await animateBetweenRows(page, /^Active$/u, /^Closed$/u);
    },
  },
  {
    id: "review",
    cursor: "visible",
    path: ({ table }) => table,
    durationSeconds: 3.5,
    prepare: async (page) => {
      await page
        .getByText("Export Review - Project Atlas Data Room")
        .first()
        .waitFor();
      await page.getByRole("grid").waitFor();
      // Rest: the second (home) row, matching the frame-0 hover state the
      // loop returns to.
      await animateBetweenRows(page, /^Active$/u, /^In Review$/u);
    },
  },
  {
    // The editor loop is a smooth document scroll with no pointer
    // interaction; a static injected cursor would read as a dead pointer (or
    // imply drag-scrolling that is not happening), so the overlay stays off.
    id: "editor",
    cursor: "hidden",
    path: () =>
      `/workspaces/${MERIDIAN_WORKSPACE_ID}/all/document` +
      "?editing=true" +
      `&entity=${SUPPLIER_AGREEMENT_ENTITY_ID}` +
      `&field=${SUPPLIER_AGREEMENT_FIELD_ID}`,
    durationSeconds: 3.5,
    prepare: prepareEditorScene,
  },
  {
    // Portrait-only document scene for the floating editor side window: the
    // same seeded Supplier Agreement in the document full view (the route
    // the inspector's "Full view" button opens), with the app sidebar
    // collapsed so the Word page fills the narrow frame. Cursor hidden for
    // the same reason as the wide editor scene: the loop is scroll-only.
    id: "editor-doc",
    collapsedSidebar: true,
    cursor: "hidden",
    path: () =>
      `/workspaces/${MERIDIAN_WORKSPACE_ID}/all/document` +
      "?editing=true" +
      `&entity=${SUPPLIER_AGREEMENT_ENTITY_ID}` +
      `&field=${SUPPLIER_AGREEMENT_FIELD_ID}`,
    durationSeconds: 3.5,
    prepare: prepareEditorScene,
  },
  {
    // The seeded Supply Agreement template open in the template studio:
    // highlighted {{...}} field placeholders, the {{#if}} conditional
    // sections, and the fields inspector panel. The template row click and
    // studio layout all settle in prepare, before the ready marker. Cursor
    // hidden: the loop is a document scroll with no pointer interaction,
    // same rationale as the editor scenes.
    id: "templates",
    cursor: "hidden",
    path: () => "/knowledge/templates",
    durationSeconds: 3.5,
    prepare: async (page) => {
      await page.getByText("Supply Agreement", { exact: true }).first().click();
      await page.locator(".layout-run-text").first().waitFor();
      // Require the painted template directives so a build that lost the
      // field highlighting can never ship a plain-document recording.
      await page.locator(TEMPLATE_FIELD_SELECTOR).first().waitFor();
      await page.locator(TEMPLATE_CONDITIONAL_SELECTOR).first().waitFor();
    },
  },
  {
    // The Knowledge tools catalogue: the app surface listing the skills and
    // capabilities the CLI and MCP server expose. Filmed as the CLI & MCP
    // chapter's own scene instead of reusing the agent chat footage.
    id: "cli",
    cursor: "visible",
    path: () => "/knowledge/tools",
    durationSeconds: 3.5,
    prepare: async (page) => {
      await page.getByRole("heading", { name: "Tools" }).first().waitFor();
      await page
        .getByText(/^Anonymise$/u)
        .first()
        .waitFor();
      await page
        .getByText(/^ARES$/u)
        .first()
        .waitFor();
      // Rest: the first (home) entry, matching the frame-0 hover state the
      // loop returns to.
      await animateBetweenRows(page, /^ARES$/u, /^Anonymise$/u);
    },
  },
  {
    id: "agent",
    cursor: "visible",
    path: ({ agent }) => agent,
    durationSeconds: 5.5,
    prepare: async (page) => {
      await page
        .getByText("Compare the change-of-control clauses across this matter.")
        .first()
        .waitFor();
      await page
        .getByText(/assignment or a material service change/u)
        .first()
        .waitFor();
      // Pre-warm both cited documents the loop will click: open each in
      // the inspector, require its folio preview to really paint (this
      // fails the run early when a preview cannot render), then close the
      // pane again so frame 0 keeps the full-width chat. The warmed
      // download/layout caches are what let the in-cut opens meet the
      // paint budget enforced in the replay.
      for (const marker of [FIRST_SOURCE_PREVIEW, SECOND_SOURCE_PREVIEW]) {
        await page.getByText(new RegExp(marker.label, "u")).first().click();
        await waitForInspectorPreview(
          page,
          marker,
          INSPECTOR_PREWARM_TIMEOUT_MS,
        );
      }
      // Pre-warming opened one inspector tab per document; close them all
      // so frame 0 keeps the full-width chat and the loop's first click
      // performs the open on camera.
      await closeAllInspectorTabs(page);
      // Rest just below-right of the first cited source: neutral (nothing
      // hovered), and the loop's first eased move starts from a short,
      // natural approach onto that source.
      const firstSource = await locatorCenter(
        page.getByText(/Aurora_Retail_Shareholder_Register_2018/u).first(),
      );
      await moveCursorTo(page, {
        x: firstSource.x + 56,
        y: firstSource.y + 44,
      });
    },
  },
  {
    // The cell-to-passage moment: a citation-bearing Table cell opens its
    // source document at the exact passage it was extracted from. Product-
    // page section only (apps/landing/src/data/products/tabular-review.ts),
    // never part of the homepage story cycle.
    id: "review-citation",
    cursor: "visible",
    path: ({ table }) => table,
    durationSeconds: 5.2,
    prepare: async (page) => {
      await page
        .getByText("Export Review - Project Atlas Data Room")
        .first()
        .waitFor();
      await page.getByRole("grid").waitFor();
      const cell = await locateExportReviewGoverningLawCell(page);

      // Pre-warm exactly like the agent scene: open the citation, require
      // the real exact-passage highlight to paint (fails the run early if
      // it cannot), then close the inspector so frame 0 keeps the plain
      // table and the loop's hover-and-click perform the open on camera.
      await openGoverningLawCitationPopover(page, cell);
      await waitForPassageHighlight(
        page,
        GOVERNING_LAW_CITATION_MARKER,
        INSPECTOR_PREWARM_TIMEOUT_MS,
      );
      await closeInspectorIfOpen(page);

      // Rest: just off the citation cell, so the loop's first eased move is
      // a short, natural approach onto it.
      const cellCenter = await locatorCenter(cell);
      await moveCursorTo(page, {
        x: cellCenter.x - 70,
        y: cellCenter.y - 34,
      });
    },
  },
  {
    // The AI-fill moment: opening the seeded Supply Agreement from within a
    // matter, expanding "Prefill from documents", picking the matter's own
    // Supplier_Agreement.docx, and the drafted field values actually
    // appearing. Product-page section only
    // (apps/landing/src/data/products/templates.ts), never part of the
    // homepage story cycle.
    id: "template-fill",
    cursor: "visible",
    path: ({ templateFillFiles }) => templateFillFiles,
    durationSeconds: 5.3,
    prepare: async (page) => {
      await page.getByText(TEMPLATE_FILL_SOURCE_DOCUMENT).first().waitFor();
      await openTemplateFillDialog(page);

      // Pre-warm exactly like the citation scene: run the real prefill once,
      // require the fixture's known Customer Name to actually paint (fails
      // the run early if the fixture ever breaks), then close and reopen
      // fresh so frame 0 keeps the pristine, nothing-filled form.
      await runTemplateFillPrefill(page);
      await waitForTemplateFillPaint(page, INSPECTOR_PREWARM_TIMEOUT_MS);
      await closeTemplateFillDialog(page);
      await openTemplateFillDialog(page);

      // Rest: just off the "Prefill from documents" toggle, so the loop's
      // first eased move is a short, natural approach onto it.
      const toggleCenter = await locatorCenter(
        page.getByRole("button", { name: TEMPLATE_FILL_PREFILL_TOGGLE_LABEL }),
      );
      await moveCursorTo(page, {
        x: toggleCenter.x - 60,
        y: toggleCenter.y - 24,
      });
    },
  },
] as const satisfies readonly StoryScene[];

// Join the shared capture matrix (viewports, watched paths) with this file's
// per-scene routes and choreography.
// eslint-disable-next-line no-map-spread -- merges each capture definition with its scene into a new record; neither source object may be mutated, and the array is tiny
const captures: readonly StoryCapture[] = captureDefinitions.map(
  (definition) => {
    const scene = scenes.find(({ id }) => id === definition.sceneId);
    if (!scene) {
      throw new Error(
        `No scene choreography for capture ${definition.captureId}`,
      );
    }
    return { ...scene, ...definition };
  },
);

// Both filters are validated up front, before authentication and browser
// setup: a typo used to match nothing and the run still exited 0, reporting
// success while leaving every requested stale asset untouched.
const parseCaptureFilter = (): ReadonlySet<string> | undefined => {
  if (!CAPTURE_FILTER) {
    return undefined;
  }
  const known = new Set(captures.map(({ captureId }) => captureId));
  const requested = CAPTURE_FILTER.split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const unknown = requested.filter((id) => !known.has(id));
  if (requested.length === 0) {
    throw new Error("MARKETING_CAPTURE is set but names no capture");
  }
  if (unknown.length > 0) {
    throw new Error(
      `MARKETING_CAPTURE names unknown capture(s): ${unknown.join(", ")}. ` +
        `Known ids: ${[...known].toSorted().join(", ")}`,
    );
  }
  return new Set(requested);
};

const parseThemeFilter = (): CaptureTheme | undefined => {
  if (!THEME_FILTER) {
    return undefined;
  }
  const theme = CAPTURE_THEMES.find((candidate) => candidate === THEME_FILTER);
  if (!theme) {
    throw new Error(
      `MARKETING_THEME must be one of ${CAPTURE_THEMES.join(", ")}; got "${THEME_FILTER}"`,
    );
  }
  return theme;
};

// The captures assert on fixture values the mock model produces (the template
// scene's drafted Customer Name, the agent scene's reply); a stack wired to a
// live provider answers differently and slowly, so a scene fails on a paint
// budget with no hint that the model is the reason. Read the file the dev
// runner hands its children (dev-runner strips inherited keys the file
// defines, so the file is authoritative) and refuse to record without it.
const assertMockAiEnabled = async () => {
  const envPath = path.join(REPO_ROOT, "apps/api/.env");
  if (!existsSync(envPath)) {
    return;
  }
  const value = (await readFile(envPath, "utf-8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("USE_MOCK_AI="))
    ?.slice("USE_MOCK_AI=".length)
    .replaceAll('"', "")
    .trim();
  if (value === "true") {
    return;
  }
  throw new Error(
    `apps/api/.env has USE_MOCK_AI=${value ?? "(unset)"}; the captures film ` +
      "the mock model's fixture values (apps/api/src/dev/register-mock-ai.ts), " +
      "so a live provider makes scenes nondeterministic and slow. Set " +
      'USE_MOCK_AI="true" and restart the stack before recording.',
  );
};

// Vite dev compiles a route's module graph on first request, and that route's
// first data fetch is uncached, so an opening take on a cold route routinely
// misses a scene's paint budget while nothing is wrong with the build. One
// warm pass over every distinct scene route pays that cost before any footage
// is recorded, and it films nothing, so a slow warm hit costs only time.
const warmSceneRoutes = async ({
  browser,
  cookies,
  views,
}: {
  browser: Browser;
  cookies: Awaited<ReturnType<typeof authenticate>>;
  views: MarketingViewRoutes;
}) => {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    viewport: NAV_VIEWPORT,
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  configurePage(page);
  for (const route of new Set(captures.map((capture) => capture.path(views)))) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
  }
  await context.close();
};

const main = async () => {
  const captureFilter = parseCaptureFilter();
  const themeFilter = parseThemeFilter();
  await assertMockAiEnabled();

  await mkdir(MEDIA_DIR, { recursive: true });
  await rm(RAW_VIDEO_DIR, { force: true, recursive: true });
  await mkdir(RAW_VIDEO_DIR, { recursive: true });

  const recordedAtCommit = await resolveRecordedAtCommit();
  const recordedEntries: RecordingManifestEntry[] = [];
  let cookies = await authenticate();
  // Playwright's screencast delivers frames at the compositor's resolution,
  // which emulated deviceScaleFactor alone does not raise: without the launch
  // flag, a 2x recordVideo size just pads 1x frames with grey. Forcing the
  // device scale at the browser level makes the compositor render at
  // CAPTURE_DPR so the video really contains device pixels. The flag is
  // browser-wide, hence one DPR for the whole capture matrix.
  const browser = await chromium.launch({
    args: [`--force-device-scale-factor=${CAPTURE_DPR}`],
    headless: true,
  });
  cookies = await selectMarketingOrganization(browser, cookies);
  const views = await resolveMarketingViewRoutes(browser, cookies);
  await warmSceneRoutes({ browser, cookies, views });

  for (const theme of ["light", "dark"] as const) {
    if (themeFilter && theme !== themeFilter) {
      continue;
    }
    for (const capture of captures) {
      if (captureFilter && !captureFilter.has(capture.captureId)) {
        continue;
      }
      // One retry per take. Every readiness wait here is a real assertion, so
      // a retry cannot ship a bad frame; what it absorbs is the marginal
      // first hit (a route the warm pass compiled but whose data was still
      // settling), which would otherwise throw away an entire 28-file run.
      // The retry is announced so a scene that always needs it stays visible
      // instead of hiding behind a green run.
      await recordCapture({ browser, capture, cookies, theme, views }).catch(
        async (error: unknown) => {
          process.stdout.write(
            `retrying ${capture.captureId} (${theme}) after: ${
              error instanceof Error ? error.message.split("\n")[0] : "unknown"
            }\n`,
          );
          return await recordCapture({
            browser,
            capture,
            cookies,
            theme,
            views,
          });
        },
      );
      recordedEntries.push({
        captureId: capture.captureId,
        theme,
        viewport: capture.viewport,
        dpr: capture.dpr,
        recordedAtCommit,
        watchedPaths: capture.watchedPaths,
      });
    }
  }

  await browser.close();
  await rm(RAW_VIDEO_DIR, { force: true, recursive: true });
  await updateRecordingsManifest(recordedEntries);
};

// The commit the recordings were made from, stamped into the manifest so
// scripts/check-marketing-recordings.ts can diff watched paths against it.
// Callers on a dirty tree should pass MARKETING_COMMIT explicitly; the
// fallback is a read-only rev-parse of HEAD.
const resolveRecordedAtCommit = async () => {
  const fromEnvironment = process.env["MARKETING_COMMIT"];
  if (fromEnvironment) {
    return fromEnvironment;
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
  });
  return stdout.trim();
};

const updateRecordingsManifest = async (
  recordedEntries: readonly RecordingManifestEntry[],
) => {
  if (recordedEntries.length === 0) {
    return;
  }
  const manifest = await readRecordingsManifest();
  const entriesByKey = new Map(
    manifest.entries.map((entry) => [manifestKey(entry), entry]),
  );
  for (const entry of recordedEntries) {
    entriesByKey.set(manifestKey(entry), entry);
  }
  const entries = [...entriesByKey.values()].sort(
    (a, b) =>
      a.captureId.localeCompare(b.captureId) || a.theme.localeCompare(b.theme),
  );
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify({ entries } satisfies RecordingsManifest, null, 2)}\n`,
  );
  process.stdout.write(
    `stamped ${recordedEntries.length} recordings in ${RECORDINGS_MANIFEST_PATH}\n`,
  );
};

const manifestKey = (entry: RecordingManifestEntry) =>
  `${entry.captureId}:${entry.theme}`;

const readRecordingsManifest = async (): Promise<RecordingsManifest> => {
  if (!existsSync(MANIFEST_PATH)) {
    return { entries: [] };
  }
  const parsed: unknown = JSON.parse(await readFile(MANIFEST_PATH, "utf-8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entries" in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new TypeError(
      `${RECORDINGS_MANIFEST_PATH} must contain an entries array`,
    );
  }
  // SAFETY: the recorder only merges over the manifest it wrote itself and
  // rewrites every field it touches; deep-validating entry shapes is the
  // check script's job.
  return { entries: parsed.entries as RecordingManifestEntry[] };
};

type AuthCookie = Awaited<ReturnType<typeof authenticate>>[number];

type RecordCaptureOptions = {
  browser: Browser;
  capture: StoryCapture;
  cookies: AuthCookie[];
  theme: CaptureTheme;
  views: MarketingViewRoutes;
};

const recordCapture = async ({
  browser,
  capture,
  cookies,
  theme,
  views,
}: RecordCaptureOptions) => {
  const context = await createRecordingContext({
    browser,
    collapsedSidebar: capture.collapsedSidebar ?? false,
    cookies,
    cursor: capture.cursor,
    dpr: capture.dpr,
    theme,
    viewport: capture.viewport,
  });
  const page = await context.newPage();
  configurePage(page);

  await page.goto(capture.path(views), { waitUntil: "commit" });
  await capture.prepare(page);
  await hideCaptureNoise(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(450);

  // Ready marker: wall-clock deltas cannot be trusted against the screencast
  // timeline (frames only flow once the page paints), so the ready moment is
  // burned into the footage itself as a solid magenta flash. The final cut
  // always starts just after the marker leaves the frame, making it
  // structurally impossible for navigation, loading, or half-ready inspector
  // states to reach a shipped file.
  const suffix = theme === "dark" ? "-dark" : "";
  const referencePath = path.join(
    RAW_VIDEO_DIR,
    `${capture.captureId}${suffix}-ready.png`,
  );
  await flashReadyMarker(page);
  await page.screenshot({ path: referencePath, scale: "device" });

  await replayCaptureMotion(page, capture.id);
  await page.waitForTimeout(capture.durationSeconds * 1000);
  // Tail buffer so the marker-anchored cut never runs out of footage.
  await page.waitForTimeout(600);

  const video = page.video();
  if (!video) {
    throw new Error(`Video recording did not start for ${capture.captureId}`);
  }

  await page.close();
  const rawPath = path.join(
    RAW_VIDEO_DIR,
    `${capture.captureId}${suffix}.webm`,
  );
  const outputPath = path.join(
    MEDIA_DIR,
    `story-${capture.captureId}${suffix}.mp4`,
  );
  const posterPath = path.join(
    MEDIA_DIR,
    `story-${capture.captureId}${suffix}-poster.jpg`,
  );
  await video.saveAs(rawPath);
  await context.close();

  const label = `${capture.captureId} (${theme})`;
  const { lastFrameSeconds, markerEndSeconds } = await findReadyMarker(
    rawPath,
    label,
  );
  const cutStartSeconds = markerEndSeconds + READY_CUT_OFFSET_SECONDS;
  if (lastFrameSeconds < cutStartSeconds + capture.durationSeconds) {
    throw new Error(
      `${label}: raw footage ends at ${lastFrameSeconds.toFixed(2)}s but the ` +
        `cut needs ${(cutStartSeconds + capture.durationSeconds).toFixed(2)}s; ` +
        "refusing to ship a shorter or earlier cut",
    );
  }

  await transcodeVideo({
    cutStartSeconds,
    durationSeconds: capture.durationSeconds,
    outputPath,
    rawPath,
  });
  await createVideoPoster({ outputPath, posterPath });
  await assertCaptureInvariants({
    durationSeconds: capture.durationSeconds,
    label,
    outputPath,
    posterPath,
    referencePath,
  });
  process.stdout.write(`recorded ${path.relative(REPO_ROOT, outputPath)}\n`);
};

const READY_MARKER_ID = "__stella_capture_ready_marker";
const READY_MARKER_HOLD_MS = 400;
const READY_MARKER_SETTLE_MS = 300;
// One screencast frame of headroom past the last magenta frame, plus a hair,
// so the marker itself can never bleed into the cut.
const READY_CUT_OFFSET_SECONDS = 0.15;
// Chroma floor for detecting the pure-magenta marker (U≈212, V≈235); app
// frames hover around neutral 128.
const READY_MARKER_MIN_CHROMA = 180;
const MIN_READY_PSNR_DB = 22;
const DURATION_TOLERANCE_SECONDS = 0.35;

const flashReadyMarker = async (page: Page) => {
  await page.evaluate((markerId) => {
    const marker = document.createElement("div");
    marker.id = markerId;
    marker.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#ff00ff;";
    document.body.append(marker);
  }, READY_MARKER_ID);
  await page.waitForTimeout(READY_MARKER_HOLD_MS);
  await page.evaluate((markerId) => {
    document.querySelector(`#${markerId}`)?.remove();
  }, READY_MARKER_ID);
  await page.waitForTimeout(READY_MARKER_SETTLE_MS);
};

type ReadyMarkerLocation = {
  lastFrameSeconds: number;
  markerEndSeconds: number;
};

// Scan the raw footage for the magenta ready marker via per-frame chroma
// averages; the cut is anchored to the video's own timeline, not wall clock.
const findReadyMarker = async (
  rawPath: string,
  label: string,
): Promise<ReadyMarkerLocation> => {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `movie=${rawPath},signalstats`,
      "-show_entries",
      "frame=pts_time:frame_tags=lavfi.signalstats.UAVG,lavfi.signalstats.VAVG",
      "-of",
      "json",
    ],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("frames" in parsed) ||
    !Array.isArray(parsed.frames)
  ) {
    throw new TypeError(`${label}: ffprobe returned no frames for ${rawPath}`);
  }

  let markerEndSeconds: number | undefined;
  let lastFrameSeconds = 0;
  for (const frame of parsed.frames) {
    if (typeof frame !== "object" || frame === null) {
      continue;
    }
    // SAFETY: shape of ffprobe's `-of json` frame entries; every field is
    // re-validated numerically before use.
    const record = frame as {
      pts_time?: string;
      tags?: Record<string, string>;
    };
    const seconds = Number(record.pts_time);
    if (!Number.isFinite(seconds)) {
      continue;
    }
    lastFrameSeconds = Math.max(lastFrameSeconds, seconds);
    const u = Number(record.tags?.["lavfi.signalstats.UAVG"]);
    const v = Number(record.tags?.["lavfi.signalstats.VAVG"]);
    if (u >= READY_MARKER_MIN_CHROMA && v >= READY_MARKER_MIN_CHROMA) {
      markerEndSeconds = seconds;
    }
  }

  if (markerEndSeconds === undefined) {
    throw new Error(
      `${label}: ready marker not found in raw footage; the recording is ` +
        "broken, refusing to guess a cut point",
    );
  }
  return { lastFrameSeconds, markerEndSeconds };
};

type AssertCaptureInvariantsOptions = {
  durationSeconds: number;
  label: string;
  outputPath: string;
  posterPath: string;
  referencePath: string;
};

// Class guard: a shipped cut must be exactly durationSeconds of post-ready
// footage, its first frame must match the ready-state reference screenshot,
// and the poster must be that same first frame (pixel-continuous handoff).
// Any violation fails the recording run.
const assertCaptureInvariants = async ({
  durationSeconds,
  label,
  outputPath,
  posterPath,
  referencePath,
}: AssertCaptureInvariantsOptions) => {
  const outputDuration = await probeDurationSeconds(outputPath);
  if (Math.abs(outputDuration - durationSeconds) > DURATION_TOLERANCE_SECONDS) {
    throw new Error(
      `${label}: output duration ${outputDuration.toFixed(2)}s deviates from ` +
        `the expected ${durationSeconds.toFixed(2)}s`,
    );
  }

  const firstFramePath = `${outputPath}.first-frame.png`;
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      outputPath,
      "-frames:v",
      "1",
      firstFramePath,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const firstFramePsnr = await psnrBetween(firstFramePath, referencePath);
  const posterPsnr = await psnrBetween(posterPath, firstFramePath);
  await rm(firstFramePath, { force: true });

  if (firstFramePsnr < MIN_READY_PSNR_DB) {
    throw new Error(
      `${label}: first frame diverges from the ready reference ` +
        `(${firstFramePsnr.toFixed(1)}dB < ${MIN_READY_PSNR_DB}dB); the cut ` +
        "contains pre-ready footage",
    );
  }
  if (posterPsnr < MIN_READY_PSNR_DB) {
    throw new Error(
      `${label}: poster diverges from the first frame ` +
        `(${posterPsnr.toFixed(1)}dB < ${MIN_READY_PSNR_DB}dB)`,
    );
  }
  process.stdout.write(
    `verified ${label}: ${outputDuration.toFixed(2)}s, first-frame ` +
      `${formatPsnr(firstFramePsnr)}, poster ${formatPsnr(posterPsnr)}\n`,
  );
};

const formatPsnr = (value: number) =>
  Number.isFinite(value) ? `${value.toFixed(1)}dB` : "identical";

const probeDurationSeconds = async (mediaPath: string) => {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    mediaPath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new TypeError(`Could not probe the duration of ${mediaPath}`);
  }
  return duration;
};

// PSNR between two stills (scale-normalised); parsed from ffmpeg's psnr
// filter summary. Returns Infinity for identical images.
const psnrBetween = async (imagePathA: string, imagePathB: string) => {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-i",
      imagePathA,
      "-i",
      imagePathB,
      "-filter_complex",
      "[0:v][1:v]scale2ref[a][b];[a][b]psnr",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const match = /average:(inf|[0-9.]+)/u.exec(stderr);
  if (!match || match[1] === undefined) {
    throw new Error(
      `Could not compute PSNR between ${imagePathA} and ${imagePathB}`,
    );
  }
  return match[1] === "inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
};

type RecordingContextOptions = {
  browser: Browser;
  collapsedSidebar: boolean;
  cookies: AuthCookie[];
  cursor: CursorMode;
  dpr: number;
  theme: CaptureTheme;
  viewport: CaptureViewport;
};

const createRecordingContext = async ({
  browser,
  collapsedSidebar,
  cookies,
  cursor,
  dpr,
  theme,
  viewport,
}: RecordingContextOptions) => {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    colorScheme: theme,
    // Record at device pixels (logical viewport x dpr) so retina screens get
    // sharp UI text instead of a 1x upscale.
    deviceScaleFactor: dpr,
    locale: "en-GB",
    recordVideo: {
      dir: RAW_VIDEO_DIR,
      size: { height: viewport.height * dpr, width: viewport.width * dpr },
    },
    viewport,
  });
  await context.addCookies(cookies);
  await context.addInitScript(
    ({ nextCollapsedSidebar, nextTheme }) => {
      localStorage.setItem("theme", nextTheme);
      if (nextCollapsedSidebar) {
        localStorage.setItem("sidebar_state", "collapsed");
      }
    },
    { nextCollapsedSidebar: collapsedSidebar, nextTheme: theme },
  );
  if (cursor === "visible") {
    await context.addInitScript(installCursorOverlay, CURSOR_OVERLAY_ID);
  }
  return context;
};

const CURSOR_OVERLAY_ID = "__stella_capture_cursor";

// Browser-side cursor overlay: headless screencasts contain no OS cursor, so
// pointer-choreographed scenes inject a macOS-style arrow (natural CSS-pixel
// size; the DPR-2 compositor scales it) that follows the real mousemove
// events Playwright's page.mouse dispatches, plus a small expanding ring on
// mousedown. It stays hidden until the first mousemove, ignores pointer
// events, and sits one z-index below the ready marker so the magenta flash
// stays solid.
const installCursorOverlay = (cursorId: string) => {
  // The arrow tip inside the SVG below; subtracted so the tip, not the SVG
  // origin, lands on the pointer coordinates.
  const hotspotX = 1.5;
  const hotspotY = 1;
  let cursorElement: HTMLDivElement | undefined;

  const ensureCursorElement = () => {
    if (cursorElement?.isConnected) {
      return cursorElement;
    }
    cursorElement = document.createElement("div");
    cursorElement.id = cursorId;
    cursorElement.style.cssText =
      "position:fixed;left:0;top:0;width:16px;height:22px;" +
      "z-index:2147483646;pointer-events:none;opacity:0;" +
      "will-change:transform;" +
      "filter:drop-shadow(0 1px 1.5px rgba(0,0,0,0.35));";
    // Static template literal with no interpolations: provably safe HTML.
    cursorElement.innerHTML = `<svg width="16" height="22"
      viewBox="0 0 16 22" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1.5 1L1.5 18.2L5.6 14.4L8.4 20.8L11.4 19.5L8.6 13.2L14 13.2Z"
      fill="#111114" stroke="#ffffff" stroke-width="1.3"
      stroke-linejoin="round"/></svg>`;
    document.body.append(cursorElement);
    return cursorElement;
  };

  document.addEventListener(
    "mousemove",
    (event) => {
      const element = ensureCursorElement();
      element.style.opacity = "1";
      element.style.transform =
        `translate3d(${event.clientX - hotspotX}px, ` +
        `${event.clientY - hotspotY}px, 0)`;
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "mousedown",
    (event) => {
      const pulse = document.createElement("div");
      pulse.style.cssText =
        `position:fixed;left:${event.clientX}px;top:${event.clientY}px;` +
        "width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:9999px;" +
        "z-index:2147483645;pointer-events:none;" +
        "border:1.5px solid rgba(255,255,255,0.95);" +
        "box-shadow:0 0 0 1px rgba(0,0,0,0.35);";
      document.body.append(pulse);
      const pulseAnimation = pulse.animate(
        [
          { opacity: 0.9, transform: "scale(0.5)" },
          { opacity: 0, transform: "scale(2.4)" },
        ],
        { duration: 300, easing: "ease-out" },
      );
      pulseAnimation.addEventListener("finish", () => {
        pulse.remove();
      });
    },
    { capture: true, passive: true },
  );
};

const configurePage = (page: Page) => {
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(120_000);
};

const selectMarketingOrganization = async (
  browser: Browser,
  cookies: AuthCookie[],
) => {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    locale: "en-GB",
    viewport: NAV_VIEWPORT,
  });
  await context.addCookies(cookies);
  const page = await context.newPage();
  configurePage(page);
  await page.goto("/auth/organization", { waitUntil: "commit" });
  const organizationRoute = "/auth/organization";
  const initialViewsRequest = page
    .waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/v1/views/${EXPORT_REVIEW_WORKSPACE_ID}`),
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  // The seeded organization's display name (apps/api/scripts/seed-test-user.ts
  // TEST_ORG); it is filmed in the sidebar chrome, so it is a real-sounding
  // firm name rather than a placeholder.
  const organization = page.getByRole("button", {
    name: MARKETING_ORGANIZATION_NAME,
  });
  await page.waitForFunction(
    ({ organizationName, routePath }) =>
      window.location.pathname !== routePath ||
      [...document.querySelectorAll("button")].some((button) =>
        button.textContent.includes(organizationName),
      ),
    {
      organizationName: MARKETING_ORGANIZATION_NAME,
      routePath: organizationRoute,
    },
  );
  if (new URL(page.url()).pathname === organizationRoute) {
    await organization.click();
  }
  await page.waitForURL((url) => url.pathname !== organizationRoute, {
    waitUntil: "commit",
  });
  await initialViewsRequest;
  const selectedCookies = await context.cookies();
  await context.close();
  return selectedCookies;
};

const resolveMarketingViewRoutes = async (
  browser: Browser,
  cookies: AuthCookie[],
): Promise<MarketingViewRoutes> => {
  const context = await browser.newContext({ baseURL: WEB_URL });
  await context.addCookies(cookies);
  const response = await context.request.get(
    `${API_URL}/v1/views/${EXPORT_REVIEW_WORKSPACE_ID}`,
  );
  if (!response.ok()) {
    throw new Error(`Could not load marketing views: ${await response.text()}`);
  }

  const payload: unknown = await response.json();
  const views = getViewRecords(payload);
  const filesView = views.find(({ layout }) => layout.type === "filesystem");
  const tableView = views.find(({ layout }) => layout.type === "table");

  const threadsResponse = await context.request.get(
    `${API_URL}/v1/chat/threads?limit=50`,
  );
  if (!threadsResponse.ok()) {
    throw new Error(
      `Could not load marketing chat: ${await threadsResponse.text()}`,
    );
  }
  const threadId = getMarketingAgentThreadId(await threadsResponse.json());

  // The template-fill scene's "Add" menu lives in the Meridian workspace's
  // own filesystem view, a separate seeded workspace from Export Review.
  const meridianViewsResponse = await context.request.get(
    `${API_URL}/v1/views/${MERIDIAN_WORKSPACE_ID}`,
  );
  if (!meridianViewsResponse.ok()) {
    throw new Error(
      `Could not load marketing views: ${await meridianViewsResponse.text()}`,
    );
  }
  const meridianFilesView = getViewRecords(
    await meridianViewsResponse.json(),
  ).find(({ layout }) => layout.type === "filesystem");

  await context.close();

  if (!filesView || !tableView || !threadId || !meridianFilesView) {
    throw new Error(
      "The seeded marketing workspaces are missing Files, Table, the agent " +
        "story, or the Meridian workspace's Files view",
    );
  }

  return {
    agent: `/chat/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/${threadId}`,
    files: `/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/${filesView.id}`,
    table: `/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/${tableView.id}`,
    templateFillFiles: `/workspaces/${MERIDIAN_WORKSPACE_ID}/${meridianFilesView.id}`,
  };
};

// `Array.isArray` narrows `unknown` to `any[]`; this keeps elements `unknown`.
const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const getMarketingAgentThreadId = (payload: unknown): string | undefined => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("workspaces" in payload) ||
    !isUnknownArray(payload.workspaces)
  ) {
    return undefined;
  }

  for (const workspace of payload.workspaces) {
    if (
      typeof workspace !== "object" ||
      workspace === null ||
      !("threads" in workspace) ||
      !isUnknownArray(workspace.threads)
    ) {
      continue;
    }
    for (const thread of workspace.threads) {
      if (
        typeof thread === "object" &&
        thread !== null &&
        "id" in thread &&
        typeof thread.id === "string" &&
        "title" in thread &&
        thread.title === MARKETING_AGENT_THREAD_TITLE
      ) {
        return thread.id;
      }
    }
  }

  return undefined;
};

type ViewRecord = {
  id: string;
  layout: { type: string };
};

const getViewRecords = (payload: unknown): ViewRecord[] => {
  if (!Array.isArray(payload)) {
    throw new TypeError("Marketing views response was not an array");
  }

  return payload.filter(isViewRecord);
};

const isViewRecord = (value: unknown): value is ViewRecord => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("id" in value) || typeof value.id !== "string") {
    return false;
  }
  if (
    !("layout" in value) ||
    typeof value.layout !== "object" ||
    value.layout === null
  ) {
    return false;
  }
  return "type" in value.layout && typeof value.layout.type === "string";
};

// Plain fetch, not playwright's request context: under Bun, playwright's
// set-cookie parser receives the relative response URL Bun's node:http
// reports and throws ERR_INVALID_URL, so the session cookies are parsed
// from the sign-in response by hand instead.
const authenticate = async () => {
  const origin = new URL(WEB_URL).origin;
  const jsonHeaders = { origin, "content-type": "application/json" };
  const sendResponse = await fetch(
    `${API_URL}/api/auth/email-otp/send-verification-otp`,
    {
      method: "POST",
      body: JSON.stringify({ email: EMAIL, type: "sign-in" }),
      headers: jsonHeaders,
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!sendResponse.ok) {
    throw new Error(await sendResponse.text());
  }

  const otpResponse = await fetch(
    `${API_URL}/dev-public/last-otp?email=${encodeURIComponent(EMAIL)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!otpResponse.ok) {
    throw new Error("Could not obtain the development marketing OTP");
  }
  const otpPayload: unknown = await otpResponse.json();
  if (
    typeof otpPayload !== "object" ||
    otpPayload === null ||
    !("otp" in otpPayload) ||
    typeof otpPayload.otp !== "string"
  ) {
    throw new Error("The development marketing OTP response had no otp field");
  }
  const signInResponse = await fetch(`${API_URL}/api/auth/sign-in/email-otp`, {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, otp: otpPayload.otp }),
    headers: jsonHeaders,
    signal: AbortSignal.timeout(15_000),
  });
  if (!signInResponse.ok) {
    throw new Error(await signInResponse.text());
  }

  // One cookie per set-cookie header, offered to both hostnames the local
  // stack answers on (the web and API hosts may differ, e.g. localhost vs
  // 127.0.0.1; the browser matches cookies by host, ignoring ports).
  const hosts = [
    ...new Set([new URL(WEB_URL).hostname, new URL(API_URL).hostname]),
  ];
  const cookies = signInResponse.headers.getSetCookie().flatMap((header) => {
    const [pair] = header.split(";");
    const separator = pair?.indexOf("=") ?? -1;
    if (pair === undefined || separator <= 0) {
      return [];
    }
    return hosts.map((domain) => ({
      name: pair.slice(0, separator).trim(),
      value: decodeURIComponent(pair.slice(separator + 1).trim()),
      domain,
      path: "/",
    }));
  });
  if (cookies.length === 0) {
    throw new Error("Sign-in succeeded but set no session cookie");
  }
  return cookies;
};

const hideCaptureNoise = async (page: Page) => {
  await page.evaluate(() => {
    const hideSidebarNoise = () => {
      for (const group of document.querySelectorAll(
        '[data-sidebar="group"], [data-slot="sidebar-group"]',
      )) {
        const label = group.querySelector(
          '[data-sidebar="group-label"], [data-slot="sidebar-group-label"]',
        );
        const labelText = label?.textContent ?? "";
        if (
          group instanceof HTMLElement &&
          labelText.trim() === "Recent chats"
        ) {
          group.style.display = "none";
        }
      }
    };
    hideSidebarNoise();
    new MutationObserver(hideSidebarNoise).observe(document.body, {
      childList: true,
      subtree: true,
    });

    const captureStyle = document.createElement("style");
    captureStyle.textContent =
      '[data-sidebar="footer"] { visibility: hidden !important; }';
    document.head.append(captureStyle);

    for (const selector of [
      "[data-sonner-toaster]",
      '[data-testid="devtools"]',
    ]) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) {
        element.style.display = "none";
      }
    }
  });
};

// Eased pointer choreography: with the cursor overlay in the frame, every
// pointer movement must be human-plausible, so all hovers and clicks route
// through moveCursorTo (ease-in-out interpolation around page.mouse.move)
// instead of Playwright's teleporting hover()/click().

type PointerPoint = { x: number; y: number };

// Playwright's virtual mouse starts at (0,0); the last commanded position is
// tracked per page so every eased move starts where the previous one ended.
const pointerPositions = new WeakMap<Page, PointerPoint>();

const CURSOR_STEP_MS = 1000 / 60;
const CURSOR_MIN_TRAVEL_MS = 280;
const CURSOR_MAX_TRAVEL_MS = 900;
const CURSOR_MS_PER_PIXEL = 1.4;
const CURSOR_PRESS_MS = 90;

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

// Human-plausible travel time: proportional to distance, clamped so short
// hops stay visible and long glides stay brisk.
const cursorTravelMs = (from: PointerPoint, to: PointerPoint) =>
  Math.min(
    CURSOR_MAX_TRAVEL_MS,
    Math.max(
      CURSOR_MIN_TRAVEL_MS,
      Math.hypot(to.x - from.x, to.y - from.y) * CURSOR_MS_PER_PIXEL,
    ),
  );

const moveCursorTo = async (page: Page, target: PointerPoint) => {
  const from = pointerPositions.get(page) ?? { x: 0, y: 0 };
  const durationMs = cursorTravelMs(from, target);
  const startedAt = Date.now();
  let elapsedMs = 0;
  while (elapsedMs < durationMs) {
    const eased = easeInOutCubic(elapsedMs / durationMs);
    await page.mouse.move(
      from.x + (target.x - from.x) * eased,
      from.y + (target.y - from.y) * eased,
    );
    await page.waitForTimeout(CURSOR_STEP_MS);
    elapsedMs = Date.now() - startedAt;
  }
  await page.mouse.move(target.x, target.y);
  pointerPositions.set(page, target);
};

const locatorCenter = async (locator: Locator): Promise<PointerPoint> => {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(
      "Cannot move the cursor to an element without a bounding box",
    );
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const hoverWithCursor = async (page: Page, locator: Locator) => {
  await moveCursorTo(page, await locatorCenter(locator));
};

const clickWithCursor = async (page: Page, locator: Locator) => {
  await hoverWithCursor(page, locator);
  await page.mouse.down();
  await page.waitForTimeout(CURSOR_PRESS_MS);
  await page.mouse.up();
};

const animateBetweenRows = async (
  page: Page,
  firstRowText: RegExp,
  secondRowText: RegExp,
) => {
  await hoverWithCursor(page, page.getByText(firstRowText).first());
  await page.waitForTimeout(750);
  await hoverWithCursor(page, page.getByText(secondRowText).first());
};

// The inspector opens store-driven (async, after the document mounts), so a
// visibility snapshot races it: wait for its Close button to appear, close,
// and wait for the pane to leave so the document reflows to full width.
// Returns whether a tab was closed: the X closes one inspector tab at a
// time, so callers that pre-warmed several tabs loop until nothing is left.
const closeInspectorIfOpen = async (page: Page): Promise<boolean> => {
  const closeButton = page.getByRole("button", { name: /^close$/iu }).last();
  const appeared = await closeButton
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    return false;
  }
  await closeButton.click();
  await closeButton
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => undefined);
  await page.waitForTimeout(500);
  return true;
};

// Close every open inspector tab (bounded so a Close button that never
// leaves cannot loop forever) and require the pane to actually be gone.
const MAX_INSPECTOR_TABS_TO_CLOSE = 4;

const closeAllInspectorTabs = async (page: Page) => {
  for (let closed = 0; closed < MAX_INSPECTOR_TABS_TO_CLOSE; closed++) {
    const closedOne = await closeInspectorIfOpen(page);
    if (!closedOne) {
      return;
    }
  }
  throw new Error(
    `inspector still open after closing ${MAX_INSPECTOR_TABS_TO_CLOSE} tabs; ` +
      "refusing to record with an unexpected pane in frame 0",
  );
};

const scrollDocumentTo = async (page: Page, top: number) => {
  await page
    .locator(".layout-run-text")
    .first()
    .evaluate((text, scrollTop) => {
      let scrollParent = text.parentElement;
      while (scrollParent) {
        if (scrollParent.scrollHeight > scrollParent.clientHeight + 40) {
          scrollParent.scrollTo({ behavior: "smooth", top: scrollTop });
          return;
        }
        scrollParent = scrollParent.parentElement;
      }
    }, top);
};

// Smooth-scroll the nearest scrollable ancestor so the located element sits
// mid-frame. The editor loop pauses on the clause-12 redline and the
// templates loop on the last clause slot, so the payoff content is on
// screen around the loop's midpoint.
const scrollElementToCenter = async (locator: Locator) => {
  await locator.evaluate((element) => {
    let scrollParent = element.parentElement;
    while (scrollParent) {
      if (scrollParent.scrollHeight > scrollParent.clientHeight + 40) {
        const parentBox = scrollParent.getBoundingClientRect();
        const elementBox = element.getBoundingClientRect();
        const centered =
          scrollParent.scrollTop +
          (elementBox.top - parentBox.top) -
          scrollParent.clientHeight / 2;
        scrollParent.scrollTo({
          behavior: "smooth",
          top: Math.max(0, centered),
        });
        return;
      }
      scrollParent = scrollParent.parentElement;
    }
  });
};

// Loop-friendly motion: every scene returns to (or near) its frame-0 state by
// the end of the cut so the video loops without a jarring jump. The hover
// loops end on the row the prepare step left hovered; the document scroll
// returns to the top. The agent scene is the exception: its two cited-source
// clicks need room to read, so it keeps a longer cut and ends on the second
// source.
const replayCaptureMotion = async (page: Page, captureId: StoryCaptureId) => {
  if (captureId === "workspace") {
    await animateRowHoverLoop(page, /^Active$/u, /^Closed$/u);
    return;
  }
  if (captureId === "review") {
    await animateRowHoverLoop(page, /^Closed$/u, /^In Review$/u);
    return;
  }
  if (captureId === "editor" || captureId === "editor-doc") {
    // Glide down through the body text to the clause-12 redline, hold long
    // enough to read the tracked change (mid-loop), then return to the top
    // so the loop closes on frame 0. The glide spans ~3 pages (~1.1s each
    // way), so the hold is what keeps the return inside the 3.5s cut.
    await scrollElementToCenter(page.locator(PAINTED_REDLINE_SELECTOR).first());
    await page.waitForTimeout(1300);
    await scrollDocumentTo(page, 0);
    return;
  }
  if (captureId === "templates") {
    // Same shape as the editor loop: glide down to the template's final
    // clause slot (past the conditional sections), hold, and return to the
    // top so the loop closes on frame 0.
    await scrollElementToCenter(page.locator(TEMPLATE_CLAUSE_SELECTOR).last());
    await page.waitForTimeout(1300);
    await scrollDocumentTo(page, 0);
    return;
  }
  if (captureId === "cli") {
    await animateRowHoverLoop(page, /^ARES$/u, /^Anonymise$/u);
    return;
  }
  if (captureId === "review-citation") {
    // Glide onto the citation cell and hover long enough for the citation
    // popover to open — a genuine click on the cell instead enters
    // row-cells.tsx's cell-expansion mode and, via AICellSourceCard's own
    // click-to-dismiss guard, prevents this same popover from opening — then
    // click through the popover so the source document opens at the
    // pre-warmed exact-passage highlight. The paint wait is deducted from
    // the hold so the loop's cadence stays fixed even on a slow re-layout.
    const cell = await locateExportReviewGoverningLawCell(page);
    await openGoverningLawCitationPopover(page, cell);
    const paintStartedAt = Date.now();
    await waitForPassageHighlight(
      page,
      GOVERNING_LAW_CITATION_MARKER,
      INSPECTOR_PREVIEW_PAINT_BUDGET_MS,
    );
    await page.waitForTimeout(
      Math.max(0, 2800 - (Date.now() - paintStartedAt)),
    );
    return;
  }
  if (captureId === "template-fill") {
    // Expand the panel, pick the matter's own Supplier_Agreement.docx, and
    // run the prefill on camera; the paint wait is deducted from the hold
    // so the loop's cadence stays fixed even on a slow re-layout. Scrolling
    // onto the Customer Name field afterward puts the actual drafted value
    // — the payoff — on screen for the back half of the cut.
    await runTemplateFillPrefill(page);
    const paintStartedAt = Date.now();
    await waitForTemplateFillPaint(page, INSPECTOR_PREVIEW_PAINT_BUDGET_MS);
    await scrollElementToCenter(
      page.locator(TEMPLATE_FILL_CUSTOMER_NAME_SELECTOR),
    );
    await page.waitForTimeout(
      Math.max(0, 1800 - (Date.now() - paintStartedAt)),
    );
    return;
  }
  // Only "agent" remains. The cursor starts from its just-off-the-source
  // rest position, glides onto each cited source, and clicks (with the
  // overlay's ring pulse); the scene deliberately ends on the second
  // source. Each click must repaint the inspector preview inside the
  // paint budget (pre-warmed in prepare); a blank pane on camera fails
  // the run, and the budget wait is deducted from the hold so the loop's
  // cadence stays fixed.
  await clickWithCursor(
    page,
    page.getByText(/Aurora_Retail_Shareholder_Register_2018/u).first(),
  );
  const firstPaintStartedAt = Date.now();
  await waitForInspectorPreview(
    page,
    FIRST_SOURCE_PREVIEW,
    INSPECTOR_PREVIEW_PAINT_BUDGET_MS,
  );
  await page.waitForTimeout(
    Math.max(0, 2600 - (Date.now() - firstPaintStartedAt)),
  );
  await clickWithCursor(
    page,
    page.getByText(/Edison_Bank_Permit_2018/u).first(),
  );
  await waitForInspectorPreview(
    page,
    SECOND_SOURCE_PREVIEW,
    INSPECTOR_PREVIEW_PAINT_BUDGET_MS,
  );
};

// Glide away, then back home (the row the prepare step ended on, i.e. the
// frame-0 hover state and cursor rest position) so the loop closes cleanly
// with the cursor back at its frame-0 spot.
const animateRowHoverLoop = async (
  page: Page,
  awayRowText: RegExp,
  homeRowText: RegExp,
) => {
  await page.waitForTimeout(450);
  await hoverWithCursor(page, page.getByText(awayRowText).first());
  await page.waitForTimeout(1600);
  await hoverWithCursor(page, page.getByText(homeRowText).first());
};

type TranscodeVideoOptions = {
  cutStartSeconds: number;
  durationSeconds: number;
  outputPath: string;
  rawPath: string;
};

const transcodeVideo = async ({
  cutStartSeconds,
  durationSeconds,
  outputPath,
  rawPath,
}: TranscodeVideoOptions) => {
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      cutStartSeconds.toFixed(3),
      "-i",
      rawPath,
      "-t",
      durationSeconds.toFixed(3),
      "-an",
      "-vf",
      "fps=18,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      // CRF 26 is the size lever for 2x captures; the 1x-era 27 read soft.
      // If UI text goes mushy here, 25 is the sanctioned fallback; verify a
      // mid-motion frame after changing.
      "-crf",
      "26",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
};

type CreateVideoPosterOptions = {
  outputPath: string;
  posterPath: string;
};

// The poster is frame 0 of the final cut, so the poster-to-video handoff is
// pixel-continuous; assertCaptureInvariants enforces this.
const createVideoPoster = async ({
  outputPath,
  posterPath,
}: CreateVideoPosterOptions) => {
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      outputPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      posterPath,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
};

await main();
