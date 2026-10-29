import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import * as v from "valibot";

import { isPublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import {
  PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD,
  PROFESSIONAL_USE_STATEMENT_VERSION,
} from "@stll/api-contract/professional-use";
import marketingCaseLaw from "@stll/playwright-tools/marketing-case-law.json" with { type: "json" };
import { setFixedBrowserTime } from "@stll/ui/browser-clock";

import {
  getMarketingAgentThreadId,
  MARKETING_AGENT_FIRST_QUESTION,
  MARKETING_AGENT_THREAD_TITLE,
  settleMarketingAgentThread,
} from "./agent-thread";
import { TIME_TRACKING_ENTRIES_SELECTOR } from "./capture-readiness";
import { CAPTURE_DPR } from "./captures";
import { getMarketingDecisionPaths } from "./case-law-reader";
import {
  assertNoActiveEditBadge,
  releaseSupplierAgreementEditLock,
  SUPPLIER_AGREEMENT_EDITOR_PATH,
  SUPPLIER_AGREEMENT_ENTITY_ID,
} from "./edit-locks";

const AKVIZICE_WORKSPACE_ID = "6cbf3f81-bcc9-55da-8a4e-840221d4cabe";
const EXPORT_REVIEW_WORKSPACE_ID = "bb8641dc-0667-574c-8e30-152a1fd4b3f5";
// Seeded `Redacted_Due_Diligence_Extract.docx` in the same matter, opened by
// the anonymization capture.
const ANONYMIZED_EXTRACT_ENTITY_ID = "c3dc74a6-7855-5157-84db-ddf14f886df4";
const ANONYMIZED_EXTRACT_FIELD_ID = "e98a6746-dae9-5509-888b-d58bfbca9a33";
// seedId("ws-due-diligence") and seedId("invoice-2") from db:seed-dev:
// INV-2025-0003, a sent invoice whose billed time entries the invoicing
// capture lists.
const DUE_DILIGENCE_WORKSPACE_ID = "fb2ce658-f761-5fdd-84c9-109a15003f49";
const SENT_INVOICE_ID = "e55ceae6-b520-565d-8cb9-96f96d928994";
const SENT_INVOICE_NUMBER = "INV-2025-0003";
// The seeded time entries span fixed dates (Dec 2024 - Feb 2025); naming the
// day in the URL keeps the timesheet off the wall-clock "today".
const TIME_TRACKING_DATE = "2024-12-13";
// The org that owns every seeded marketing workspace (AKVIZICE/EXPORT_REVIEW/
// Meridian). Fixed id from seed-utils' DEFAULT_ORG_ID ("Harbrook & Partners",
// apps/api/scripts/seed-test-user.ts), seeded by
// db:seed-test-user then populated by db:seed-dev. A fresh email-OTP sign-in
// starts with no active organization, so we set it server-side (below) instead
// of driving the org-picker UI, which the workspace routes below depend on.
const MARKETING_ORGANIZATION_ID = "test-org-stella-dev";
// Duplicated from apps/web/src/consts.ts, exactly as
// apps/web/public/prepaint-init.js duplicates it: the e2e project has no
// `@/` path alias. Writing any other key silently leaves the app on its
// system colour-scheme preference.
const THEME_STORAGE_KEY = "stella-ui-theme";
const INSPECTOR_STORAGE_PREFIXES = [
  "stella:inspector-minimized:v1:",
  "stella:inspector-state:v1:",
] as const;
const requestedCapture = process.env["MARKETING_CAPTURE"];
const MARKETING_URLS = {
  apiUrl: process.env["E2E_API_URL"] ?? "http://localhost:3001",
  webUrl: process.env["E2E_WEB_URL"] ?? "http://localhost:3000",
};

// Route chunks are compiled on demand by the dev server, so the first visit to
// each route pays a cold build that the config's 15s expect timeout cannot
// cover on a CI runner. Mirrors the same allowance in e2e/specs/route-smoke.
const COLD_COMPILE_TIMEOUT = 60_000;

// The document inspector renders `${versionLabel} · ${formatRelativeTime(...)}`
// against the current version's timestamp, so the caption changes with wall
// clock time and drifts every baseline it appears in. Captures carrying a
// `versionAnchor` pin the page clock this far past that timestamp, so the
// caption renders the same string on every run: five minutes sits well inside
// `formatRelativeTime`'s minute bucket (one minute to one hour), far from
// either boundary, and reads as a natural "just edited" label.
const VERSION_CAPTION_OFFSET_MS = 5 * 60_000;

// The product-shot frame for captures without their own clip: the app's main
// column, below the sidebar.
const DEFAULT_CLIP = { x: 255, y: 0, width: 1137, height: 710 } as const;

const captures = [
  {
    name: "workspace",
    path: `/workspaces/${AKVIZICE_WORKSPACE_ID}/`,
    prepare: "open-files",
    readyText: "Meridian supply agreement",
  },
  {
    name: "tabular-review",
    path: `/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/`,
    prepare: "open-table",
    readyText: "Export Review - Project Atlas Data Room",
  },
  ...marketingCaseLaw.map(
    (scenario, index) =>
      ({
        name: `story-public-data-${String(index + 1)}`,
        prepare: "open-decision",
        country: scenario.country,
        decisionText: scenario.caseNumber,
        readyText: "Case Law",
        clip: { x: 0, y: 0, width: 1440, height: 760 },
      }) as const,
  ),
  {
    name: "editor",
    path: SUPPLIER_AGREEMENT_EDITOR_PATH,
    readyText: "Supplier_Agreement.docx",
    readySelector: '[aria-label="Document content"][contenteditable="true"]',
    // `?editing=true` is a request, not a state: without this the shot can
    // land on the read-only viewer while the editor is still unlocking. The
    // editable ProseMirror surface exists only after the request succeeds.
    versionAnchor: {
      workspaceId: AKVIZICE_WORKSPACE_ID,
      entityId: SUPPLIER_AGREEMENT_ENTITY_ID,
    },
  },
  {
    // The seeded change-of-control thread in the Export Review matter
    // (apps/api/scripts/seed-marketing-agent-thread.ts), resolved by title so
    // the shot never lands on the empty /chat/new composer.
    name: "agent",
    prepare: "open-agent-thread",
    // The thread's first question; the answers, citations, generated view
    // and recap are awaited in the "open-agent-thread" prepare block below so
    // the shot never ships mid-render.
    readyText: MARKETING_AGENT_FIRST_QUESTION,
  },
  { name: "templates", path: "/knowledge/templates", readyText: "Templates" },
  {
    name: "anonymization",
    path:
      `/workspaces/${AKVIZICE_WORKSPACE_ID}/all/document` +
      `?entity=${ANONYMIZED_EXTRACT_ENTITY_ID}` +
      `&field=${ANONYMIZED_EXTRACT_FIELD_ID}`,
    readyText: "Redacted_Due_Diligence_Extract.docx",
    readySelector: ".layout-run-text",
    versionAnchor: {
      workspaceId: AKVIZICE_WORKSPACE_ID,
      entityId: ANONYMIZED_EXTRACT_ENTITY_ID,
    },
  },
  {
    // Contacts are listed by display name, so the first seeded organisation
    // heads the list on every run.
    name: "contacts",
    path: "/contacts",
    readyText: "Bratislava Legal Group, s.r.o.",
  },
  {
    name: "time-tracking",
    path: `/time?date=${TIME_TRACKING_DATE}`,
    prepare: "await-time-entries",
    readyText: "Timesheets",
  },
  {
    name: "invoicing",
    path: `/workspaces/${DUE_DILIGENCE_WORKSPACE_ID}/invoices/${SENT_INVOICE_ID}`,
    prepare: "await-invoice-entries",
    readyText: SENT_INVOICE_NUMBER,
  },
  {
    // The Export Review table with its export menu open.
    name: "import-export",
    path: `/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/`,
    prepare: "open-table-export",
    readyText: "Export Review - Project Atlas Data Room",
  },
  {
    // The Czech results listing without a query: every seeded CZE decision,
    // in the listing's own order. A keyword query depends on what the
    // best-effort seed search index matched and returned no rows in CI.
    name: "case-law-search",
    path: "/law/cases?country=cze",
    prepare: "await-search-results",
    country: "CZE",
    readyText: "Case Law",
    clip: { x: 0, y: 0, width: 1440, height: 760 },
  },
] as const;

// Stills share the recordings' device pixel ratio, so the PNGs are twice the
// CSS clip size and stay sharp on retina screens. Clips stay in CSS pixels.
test.use({ deviceScaleFactor: CAPTURE_DPR });

test("capture landing product screenshots", async ({
  context,
  page,
  request,
}) => {
  await authenticateMarketingSession(request);
  const { cookies } = await request.storageState();
  await context.addCookies(cookies);

  // The active organization is set server-side in authenticateMarketingSession
  // (via better-auth's set-active endpoint), so the workspace routes below are
  // already org-scoped — no org-picker UI to drive. Land on a real page first:
  // a fresh page sits on about:blank, where the localStorage access in the
  // theme loop below throws a SecurityError.
  await page.goto("/law", { waitUntil: "domcontentloaded" });
  // `domcontentloaded` only means the document parsed; on a cold dev server the
  // client still has to compile and hydrate the app before anything but the
  // splash paints (measured at ~11s locally, several times that on a CI
  // runner). Absorb that one-time cost here so the per-capture waits below
  // only ever cover a route transition.
  await expect(page.locator("main").first()).toBeVisible({
    timeout: COLD_COMPILE_TIMEOUT,
  });
  await expect(page.getByText("Legal database").first()).toBeVisible({
    timeout: COLD_COMPILE_TIMEOUT,
  });

  // Start from no edit lock: a lock left by an earlier run would badge the
  // Supplier Agreement row in the workspace shot.
  await releaseSupplierAgreementEditLock(page.request, MARKETING_URLS);

  // Resolved once (not per capture/theme): only needed when the "agent"
  // capture is actually part of this run.
  const agentThreadPath =
    !requestedCapture || requestedCapture === "agent"
      ? await resolveAgentThreadPath(page.request)
      : undefined;

  const decisionPaths =
    !requestedCapture || requestedCapture.startsWith("story-public-data-")
      ? await resolveDecisionPaths(page.request)
      : new Map<string, string>();

  // Whether the shared page still carries a pinned clock from a previous
  // capture; see the anchor block in the capture loop.
  let clockPinned = false;

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    // Pin the stored theme as well as the media preference. localStorage is
    // origin-scoped, so this survives the navigations below; both inputs must
    // agree because prepaint-init.js reads the stored value first and only
    // falls back to the media query.
    await page.evaluate(
      ([storageKey, nextTheme]) => {
        localStorage.setItem(storageKey, nextTheme);
      },
      [THEME_STORAGE_KEY, theme] as const,
    );

    for (const capture of captures) {
      if (requestedCapture && capture.name !== requestedCapture) {
        continue;
      }
      if ("country" in capture) {
        expect(
          isPublicCaseLawCountry(capture.country),
          `${capture.name}: the filmed jurisdiction is publicly supported`,
        ).toBe(true);
      }
      const decisionPath =
        "decisionText" in capture
          ? decisionPaths.get(capture.decisionText)
          : undefined;
      const declaredPath = "path" in capture ? capture.path : agentThreadPath;
      const capturePath =
        "decisionText" in capture ? decisionPath : declaredPath;
      if (!capturePath) {
        throw new Error(`${capture.name}: no path resolved for this capture`);
      }
      await clearPersistedInspectorState(page);
      // Anchor the inspector's relative timestamp before navigating, so the
      // caption paints with the pinned clock on its first render. Captures
      // without an anchor run on real time; the clock is only restored when a
      // previous capture actually pinned it, so the captures that never
      // show a timestamp keep an untouched Date/timer implementation.
      if ("versionAnchor" in capture) {
        const versionCreatedAt = await resolveCurrentVersionCreatedAt(
          page.request,
          capture.versionAnchor,
        );
        await setFixedBrowserTime(
          page,
          versionCreatedAt.getTime() + VERSION_CAPTION_OFFSET_MS,
        );
        clockPinned = true;
      } else if (clockPinned) {
        await page.clock.setSystemTime(Date.now());
        clockPinned = false;
      }
      // The navigation policy reads `waitUntil` as a literal, so the two
      // lifecycles are separate calls.
      if ("decisionText" in capture) {
        await page.goto(capturePath, { waitUntil: "commit" });
      } else {
        await page.goto(capturePath, { waitUntil: "domcontentloaded" });
      }
      await expect(page).not.toHaveURL(/\/sign-in(?:\/|\?|$)/u);
      // Each capture is the first visit to its route, so its chunk compiles on
      // demand here too; the config's 15s expect timeout is not enough for that
      // on a CI runner.
      await expect(page.getByText(capture.readyText).first()).toBeVisible({
        timeout: COLD_COMPILE_TIMEOUT,
      });
      if ("readySelector" in capture) {
        await expect(page.locator(capture.readySelector).first()).toBeVisible({
          timeout: COLD_COMPILE_TIMEOUT,
        });
      }
      if ("prepare" in capture && capture.prepare === "open-decision") {
        // Open the reader directly from its seeded conversation metadata.
        // Search-page SSR is independent of the completed reader state.
        await expect(page).toHaveURL(/\/law\/[a-z-]+\/cases\//u);
        // The case detail is its own code-split chunk, so this is the first
        // load of another route: same cold-compile allowance as the
        // navigations above, not the config's 15s default.
        await expect(page.locator("article").first()).toBeVisible({
          timeout: COLD_COMPILE_TIMEOUT,
        });
        // The reader briefly renders the logged-out workspace while the
        // client-side session query settles, then swaps in the authenticated
        // workspace. Wait for that swap before checking its generated outline.
        await page.waitForLoadState("networkidle");
        // The authenticated inspector is mounted beside this public route.
        // Catch route-context crashes at their boundary instead of timing out
        // later on whichever product control the error screen replaced.
        await expect(page.locator("#route-error-title")).toHaveCount(0);
        // These decisions have analysis cached server-side. Wait for the
        // automatic fetch so the capture never lands on the loading margin.
        await expect(
          page.getByRole("group", { name: "Contents" }),
        ).toBeVisible();
        // Decision routes intentionally seed their inspector tabs without
        // opening the pane. This capture includes the chat, so open it as an
        // explicit user action and assert the route honored that contract.
        const inspectorDock = page.locator('[data-slot="inspector-dock"]');
        await inspectorDock
          .getByRole("button", { exact: true, name: "Show pane" })
          .click();
        const scenario = marketingCaseLaw.find(
          (item) => item.caseNumber === capture.decisionText,
        );
        if (scenario === undefined) {
          throw new Error(`${capture.name}: no rich reader scenario`);
        }
        const inspectorChat = page.locator(
          '[data-slot="inspector-chat-panel"]:visible',
        );
        await expect(inspectorChat).toHaveCount(1, {
          timeout: COLD_COMPILE_TIMEOUT,
        });
        const messages = inspectorChat.locator("[data-chat-message-id]");
        await expect(messages).toHaveCount(4, {
          timeout: COLD_COMPILE_TIMEOUT,
        });
        for (const [index, text] of [
          scenario.question,
          scenario.answer,
          scenario.followUp,
          scenario.followUpAnswer,
        ].entries()) {
          await expect(messages.nth(index)).toContainText(text);
        }
        await expect(
          inspectorChat.locator('[data-slot="prompt-suggestions"]'),
        ).toHaveCount(0);
        const citations = inspectorChat.locator("[data-decision-citation]");
        await expect(citations).toHaveCount(2);
        // Compact inline cards show the court's short form; the full case
        // number is their accessible name.
        await expect(citations.first()).toHaveAttribute(
          "aria-label",
          expect.stringContaining(scenario.caseNumber),
        );
        await inspectorChat
          .locator('[data-slot="scroll-area-viewport"]')
          .evaluate((element) => {
            element.scrollTop = 0;
          });

        // Align the earlier marked paragraph with the reader's top, rather
        // than centering it against the taller browser viewport.
        const clip = "clip" in capture ? capture.clip : DEFAULT_CLIP;
        const readerAnchors = page.locator(
          `article [data-anchor="${scenario.highlightAnchor}"], article [data-anchor="${scenario.underlineAnchor}"]`,
        );
        await expect(readerAnchors).toHaveCount(2);
        await readerAnchors.evaluateAll((elements, clipTop) => {
          const first = elements.at(0);
          const scroller = first?.closest(".reader-scroll");
          if (scroller === undefined || scroller === null) {
            throw new Error("The case-law reader has no scroll container");
          }
          const anchorTop = Math.min(
            ...elements.map((element) => element.getBoundingClientRect().top),
          );
          const frameTop = Math.max(
            clipTop,
            scroller.getBoundingClientRect().top,
          );
          scroller.scrollTop += anchorTop - frameTop - 16;
        }, clip.y);
        await page.evaluate(() => window.scrollTo({ left: 0, top: 0 }));
        // The left notes column is the point of this shot. Require the
        // seeded AI note and comment as typed margin notes, not merely text
        // in some `aside`, and no visitor placeholders in their place.
        const notesColumn = page.locator("aside[data-reader-notes-column]");
        await expect(notesColumn).toBeVisible();
        await expect(
          notesColumn.locator('[data-margin-note="example"]'),
        ).toHaveCount(0);
        const requiredElements = [
          notesColumn
            .locator(
              '[data-margin-note="card"], [data-margin-note="annotation"]',
            )
            .getByText(scenario.aiNote, { exact: true }),
          notesColumn
            .locator('[data-margin-note="comment"]')
            .getByText(scenario.comment, { exact: true }),
        ];
        for (const [anchor, variant, paragraphNumber] of [
          [
            scenario.highlightAnchor,
            "text-foreground",
            scenario.highlightNumber,
          ],
          [scenario.underlineAnchor, "underline", scenario.underlineNumber],
        ] as const) {
          requiredElements.push(
            page
              .locator(
                `article [data-anchor="${anchor}"] mark[data-annotation-id].${variant}:not(.decoration-dotted)`,
              )
              .first(),
          );
          // A published paragraph number stays visible independently of
          // how long the paragraph below it is.
          const number = page.locator(
            `article [data-anchor="${anchor}"] > span.reader-chrome.absolute`,
          );
          await expect(number).toHaveCount(1);
          await expect(number).toHaveText(String(paragraphNumber));
          requiredElements.push(number);
        }
        requiredElements.push(
          ...(await messages.all()),
          ...(await citations.all()),
        );
        for (const element of requiredElements) {
          await expect(element).toBeVisible();
          await expect(element).toBeInViewport({ ratio: 1 });
          await expect
            .poll(
              async () => {
                const box = await element.boundingBox();
                return (
                  box !== null &&
                  box.x >= clip.x &&
                  box.y >= clip.y &&
                  box.x + box.width <= clip.x + clip.width &&
                  box.y + box.height <= clip.y + clip.height
                );
              },
              {
                message: `${capture.name}: required reader content fits the screenshot clip`,
              },
            )
            .toBe(true);
        }
        await expectNoMarginNoteCut(page, clip.y);
      }
      if ("prepare" in capture && capture.prepare === "open-files") {
        await page.getByRole("tab", { name: "Files" }).click();
        await expect(page).toHaveURL(
          new RegExp(`/workspaces/${AKVIZICE_WORKSPACE_ID}/[^/?]+`, "u"),
        );
        await expect(
          page.getByText("Internal_SAFE_Agreement.docx").first(),
        ).toBeVisible();
        // Both themes must show the same rows: no document carries an edit
        // lock badge (the editor capture releases its lock below).
        await expect(
          page.getByText("Supplier_Agreement.docx").first(),
        ).toBeVisible();
        await assertNoActiveEditBadge(page, capture.name);
      }
      if ("prepare" in capture && capture.prepare === "open-table") {
        await page.getByRole("tab", { name: "Table" }).click();
        await expect(page.getByRole("grid")).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "await-time-entries") {
        await expect(
          page.locator(TIME_TRACKING_ENTRIES_SELECTOR).first(),
        ).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "await-invoice-entries") {
        await expect(page.getByText("Linked time entries")).toBeVisible();
        await expect(page.locator("table tbody tr").first()).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "open-table-export") {
        await page.getByRole("tab", { name: "Table" }).click();
        await expect(page.getByRole("grid")).toBeVisible();
        await page
          .getByRole("button", { exact: true, name: "Export table" })
          .first()
          .click();
        await expect(
          page.getByRole("menuitem", { name: "Export XLSX" }),
        ).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "await-search-results") {
        // Several result rows, not just the first, so the shot shows a list
        // rather than a single hit.
        await expect(
          page.locator('main a[href*="/cases/"]').nth(1),
        ).toBeVisible({ timeout: COLD_COMPILE_TIMEOUT });
        await page.waitForLoadState("networkidle");
        await expect(page.locator("#route-error-title")).toHaveCount(0);
      }
      if ("prepare" in capture && capture.prepare === "open-agent-thread") {
        // Waits for every answer, citation chip, the generated view's guest
        // page (content, fonts, final height, host theme) and the recap, then
        // frames the final turn. The guest page has no animations or
        // transitions of its own, so the animation freeze below, which the
        // style tag applies to this document only, misses nothing.
        await settleMarketingAgentThread(page, {
          frameBottom: DEFAULT_CLIP.y + DEFAULT_CLIP.height,
        });
      }
      await page.locator("body").waitFor({ state: "visible" });
      await page.evaluate(async () => document.fonts.ready);
      await page.waitForTimeout(300);
      await page.addStyleTag({
        content: `
          *, *::before, *::after {
            animation-delay: 0s !important;
            animation-duration: 0s !important;
            caret-color: transparent !important;
            transition-duration: 0s !important;
          }
          [data-sonner-toaster], [data-testid="devtools"], [data-dev-chrome] { display: none !important; }
        `,
      });

      const themeSuffix = theme === "dark" ? "-dark" : "";
      // Soft, so one run reports every drifted capture; a hard assertion
      // aborts the loop at the first mismatch and hides the rest until the
      // next run.
      await expect
        .soft(page)
        .toHaveScreenshot(`${capture.name}${themeSuffix}.png`, {
          animations: "disabled",
          caret: "hide",
          clip: "clip" in capture ? capture.clip : DEFAULT_CLIP,
          // Baselines are produced on the CI runner by the "Update marketing
          // screenshots" workflow (.github/workflows/
          // marketing-screenshots-update.yml) and compared on that same runner
          // image, so this only has to absorb run-to-run rendering noise, not
          // a macOS-to-Linux font gap. Dispatch that workflow on the branch
          // when the UI change is intended.
          maxDiffPixelRatio: 0.005,
          scale: "device",
        });
      // `?editing=true` opened an edit session, i.e. a lease-backed lock on the
      // Supplier Agreement. A full navigation never unmounts the editor, so
      // the session would outlive this capture and badge the document in the
      // next theme pass's workspace shot. Release it explicitly.
      if (capture.name === "editor") {
        await releaseSupplierAgreementEditLock(page.request, MARKETING_URLS);
      }
    }
  }
});

// Each product capture owns its Inspector state. Full navigation creates a
// fresh store, while removing the persisted Inspector state prevents an editor
// or minimized layout from leaking into an unrelated route or the next theme
// pass.
const clearPersistedInspectorState = async (page: Page) => {
  await page.evaluate((storagePrefixes) => {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key && storagePrefixes.some((prefix) => key.startsWith(prefix))) {
        localStorage.removeItem(key);
      }
    }
  }, INSPECTOR_STORAGE_PREFIXES);
};

// No margin note is half hidden at the top of the margin, under the sticky
// section header or the frame's top edge. One running off the bottom edge
// is fine: it reads as the page continuing.
const expectNoMarginNoteCut = async (page: Page, clipTop: number) => {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          (band) => {
            const scroller = document
              .querySelector('[data-slot="reader-document-column"]')
              ?.closest(".reader-scroll");
            if (!(scroller instanceof HTMLElement)) {
              return ["the reader's scroller is missing"];
            }
            const frame = scroller.getBoundingClientRect();
            // A note under the margin's sticky section header is as cut as
            // one under the frame's edge: the header's contents bound it.
            const aside = scroller
              .querySelector('[data-slot="reader-document-column"]')
              ?.parentElement?.querySelector("aside");
            const stuckBottoms = aside
              ? [...aside.querySelectorAll<HTMLElement>("*")]
                  .filter(
                    (element) =>
                      getComputedStyle(element).position === "sticky" &&
                      element.getBoundingClientRect().top <= frame.top + 1,
                  )
                  .map((element) =>
                    Math.max(
                      element.getBoundingClientRect().bottom,
                      ...[...element.querySelectorAll("*")].map(
                        (child) => child.getBoundingClientRect().bottom,
                      ),
                    ),
                  )
              : [];
            const top = Math.max(frame.top, band.top, ...stuckBottoms);
            const cut: string[] = [];
            for (const note of document.querySelectorAll(
              "[data-margin-note] > *",
            )) {
              const box = note.getBoundingClientRect();
              if (box.top < top && box.bottom > top) {
                const kind = note.parentElement?.dataset["marginNote"] ?? "?";
                cut.push(
                  `${kind} note "${note.textContent.slice(0, 40)}" spans ${String(Math.round(box.top))}-${String(Math.round(box.bottom))}`,
                );
              }
            }
            return cut;
          },
          { top: clipTop },
        ),
      {
        message: "No margin note may be half hidden at the top of the margin",
      },
    )
    .toEqual([]);
};

// Resolves the seeded agent thread's route by title via the chat threads
// API (the same lookup record-product-story.ts's resolveMarketingViewRoutes
// uses), instead of a fixed thread id that would need updating whenever the
// dev seed reruns.
const resolveAgentThreadPath = async (request: APIRequestContext) => {
  const apiBaseURL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
  const response = await request.get(`${apiBaseURL}/v1/chat/threads?limit=50`);
  expect(response.ok(), await response.text()).toBe(true);
  const threadId = getMarketingAgentThreadId(await response.json());
  if (!threadId) {
    throw new Error(
      `Could not find the seeded "${MARKETING_AGENT_THREAD_TITLE}" thread ` +
        "for the agent screenshot",
    );
  }
  return `/chat/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/${threadId}`;
};

const DECISION_THREAD_PAGE_LIMIT = 100;
const threadPageSchema = v.object({
  global: v.array(v.unknown()),
  nextCursor: v.nullable(v.string()),
});

// The threads endpoint lists newest first, so the seeded readers can sit
// beyond the first page on a busy dev account: follow its cursor to the end.
const resolveDecisionPaths = async (request: APIRequestContext) => {
  const global: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < DECISION_THREAD_PAGE_LIMIT; page++) {
    const query: string =
      cursor === null
        ? "limit=50"
        : `limit=50&cursor=${encodeURIComponent(cursor)}`;
    const response = await request.get(
      `${MARKETING_URLS.apiUrl}/v1/chat/threads?${query}`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    const payload: unknown = await response.json();
    const parsed = v.safeParse(threadPageSchema, payload);
    if (!parsed.success) {
      throw new Error("Chat thread list response is malformed");
    }
    global.push(...parsed.output.global);
    if (parsed.output.nextCursor === null) {
      return getMarketingDecisionPaths({ global });
    }
    cursor = parsed.output.nextCursor;
  }
  throw new Error(
    `Chat thread list exceeded ${String(DECISION_THREAD_PAGE_LIMIT)} pages`,
  );
};

// Reads the timestamp the inspector's version caption formats, from the same
// endpoint the panel's query uses
// (apps/api/src/handlers/entities/routes.ts, `/entity/:entityId/versions`).
const resolveCurrentVersionCreatedAt = async (
  request: APIRequestContext,
  { workspaceId, entityId }: { workspaceId: string; entityId: string },
) => {
  const apiBaseURL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
  const response = await request.get(
    `${apiBaseURL}/v1/entities/${workspaceId}/entity/${entityId}/versions`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  const createdAt = getCurrentVersionCreatedAt(await response.json());
  if (createdAt === undefined) {
    throw new Error(
      `Entity ${entityId} has no current version timestamp; the capture would ` +
        "record a relative caption that changes on every run",
    );
  }
  const parsed = new Date(createdAt);
  expect(
    Number.isNaN(parsed.getTime()),
    `Entity ${entityId} reported an unparseable version timestamp: ${createdAt}`,
  ).toBe(false);
  return parsed;
};

const getCurrentVersionCreatedAt = (payload: unknown): string | undefined => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("versions" in payload) ||
    !isUnknownArray(payload.versions) ||
    !("currentVersionId" in payload) ||
    typeof payload.currentVersionId !== "string"
  ) {
    return undefined;
  }

  const { currentVersionId } = payload;
  for (const version of payload.versions) {
    if (
      typeof version === "object" &&
      version !== null &&
      "id" in version &&
      version.id === currentVersionId &&
      "createdAt" in version &&
      typeof version.createdAt === "string"
    ) {
      return version.createdAt;
    }
  }

  return undefined;
};

// `Array.isArray` narrows `unknown` to `any[]`; this keeps elements `unknown`.
const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const authenticateMarketingSession = async (request: APIRequestContext) => {
  const apiBaseURL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
  const webOrigin = new URL(
    process.env["E2E_WEB_URL"] ?? "http://localhost:3000",
  ).origin;
  const email = "test@stella.dev";
  const sendResponse = await request.post(
    `${apiBaseURL}/api/auth/email-otp/send-verification-otp`,
    { data: { email, type: "sign-in" }, headers: { origin: webOrigin } },
  );
  expect(sendResponse.ok(), await sendResponse.text()).toBe(true);

  const otpResponse = await request.get(
    `${apiBaseURL}/dev-public/last-otp?email=${encodeURIComponent(email)}`,
  );
  expect(otpResponse.ok()).toBe(true);
  const { otp } = await otpResponse.json();

  const signInResponse = await request.post(
    `${apiBaseURL}/api/auth/sign-in/email-otp`,
    {
      data: {
        email,
        otp,
        [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
          PROFESSIONAL_USE_STATEMENT_VERSION,
      },
      headers: { origin: webOrigin },
    },
  );
  expect(signInResponse.ok(), await signInResponse.text()).toBe(true);

  // A fresh sign-in has no active organization; set it on the session so the
  // workspace captures resolve without the org-picker UI. The session cookie
  // (copied into the browser context by the caller) then carries this scope.
  const setActiveResponse = await request.post(
    `${apiBaseURL}/api/auth/organization/set-active`,
    {
      data: { organizationId: MARKETING_ORGANIZATION_ID },
      headers: { origin: webOrigin },
    },
  );
  expect(setActiveResponse.ok(), await setActiveResponse.text()).toBe(true);
};
