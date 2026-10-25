import { expect, test } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import * as v from "valibot";

import {
  isPublicCaseLawCountry,
  isPublicCaseLawPageCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import {
  PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD,
  PROFESSIONAL_USE_STATEMENT_VERSION,
} from "@stll/api-contract/professional-use";
import { MARKETING_CASE_LAW } from "@stll/playwright-tools/marketing-case-law";
import {
  MARKETING_LOCALE_ACCOUNTS,
  MARKETING_LOCALE_MARKERS,
  MARKETING_LOCALES,
} from "@stll/playwright-tools/marketing-locales";
import type { MarketingLocale } from "@stll/playwright-tools/marketing-locales";
import { setFixedBrowserTime } from "@stll/ui/browser-clock";

import {
  getMarketingAgentThreadId,
  settleMarketingAgentThread,
} from "./agent-thread";
import { CAPTURE_DPR } from "./captures";
import { getMarketingDecisionPaths } from "./case-law-reader";
import {
  assertNoActiveEditBadge,
  releaseSupplierAgreementEditLock,
  supplierAgreementEditorPath,
} from "./edit-locks";
import { marketingSeedIds } from "./seed-ids";
import { uiText } from "./ui-text";

// Duplicated from apps/web/src/consts.ts, exactly as
// apps/web/public/prepaint-init.js duplicates it: the e2e project has no
// `@/` path alias. Writing any other key silently leaves the app on its
// system colour-scheme preference.
const THEME_STORAGE_KEY = "stella-ui-theme";
// The language picker's persisted store (apps/web/src/i18n/i18n-store.ts,
// `getStorageKey("i18n")`), which prepaint-init.js reads as I18N_STORAGE_KEY.
const I18N_STORAGE_KEY = "stella-i18n";
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

// The time entries span fixed dates (Dec 2024 - Feb 2025); naming the day in
// the URL keeps the timesheet off the wall-clock "today".
const TIME_TRACKING_DATE = "2024-12-13";

/**
 * Every product shot of one locale's firm. All content comes from that
 * firm's seed (apps/api/scripts/seed-marketing-locales.ts, English:
 * db:seed-dev), including the AI answers, which are stored fixtures.
 */
const capturesFor = (locale: MarketingLocale) => {
  const ids = marketingSeedIds(locale);
  const markers = MARKETING_LOCALE_MARKERS[locale];
  const caseLawSearchCountry = markers.caseLawSearchCountry;
  return [
    {
      name: "workspace",
      path: `/workspaces/${ids.meridianWorkspaceId}/`,
      prepare: "open-files",
      readyText: markers.meridianMatterName,
    },
    {
      name: "tabular-review",
      path: `/workspaces/${ids.exportReviewWorkspaceId}/`,
      prepare: "open-table",
      readyText: markers.exportReviewMatterName,
    },
    ...MARKETING_CASE_LAW[locale].map(
      (scenario, index) =>
        ({
          name: `story-public-data-${String(index + 1)}`,
          prepare: "open-decision",
          country: scenario.country,
          decisionText: scenario.caseNumber,
          readyText: uiText(locale, "common.caseLaw"),
          clip: { x: 0, y: 0, width: 1440, height: 760 },
        }) as const,
    ),
    {
      name: "editor",
      path: supplierAgreementEditorPath(ids.supplierAgreement),
      readyText: markers.supplierAgreementFileName,
      readySelector: '[aria-label="Document content"][contenteditable="true"]',
      // `?editing=true` is a request, not a state: without this the shot can
      // land on the read-only viewer while the editor is still unlocking. The
      // editable ProseMirror surface exists only after the request succeeds.
      versionAnchor: {
        workspaceId: ids.meridianWorkspaceId,
        entityId: ids.supplierAgreement.entityId,
      },
    },
    {
      // The seeded change-of-control thread in the Export Review matter
      // (apps/api/scripts/seed-marketing-agent-thread.ts), resolved by title so
      // the shot never lands on the empty /chat/new composer.
      name: "agent",
      prepare: "open-agent-thread",
      // The thread's first question; the answers, citations, generated view
      // and recap are awaited in the "open-agent-thread" prepare block below
      // so the shot never ships mid-render.
      readyText: markers.agent.questions[0],
    },
    {
      name: "templates",
      path: "/knowledge/templates",
      readyText: uiText(locale, "navigation.templates"),
    },
    {
      name: "anonymization",
      path:
        `/workspaces/${ids.meridianWorkspaceId}/all/document` +
        `?entity=${ids.anonymizedExtract.entityId}` +
        `&field=${ids.anonymizedExtract.fieldId}`,
      readyText: markers.redactedExtractFileName,
      readySelector: ".layout-run-text",
      versionAnchor: {
        workspaceId: ids.meridianWorkspaceId,
        entityId: ids.anonymizedExtract.entityId,
      },
    },
    {
      // Contacts are listed by display name, so the first seeded organisation
      // heads the list on every run.
      name: "contacts",
      path: "/contacts",
      readyText: markers.firstContactName,
    },
    {
      name: "time-tracking",
      path: `/time?date=${TIME_TRACKING_DATE}`,
      prepare: "await-time-entries",
      readyText: uiText(locale, "billing.timesheets"),
    },
    {
      // The sent invoice (`invoice-2`) whose billed time entries the
      // capture lists.
      name: "invoicing",
      path: `/workspaces/${ids.dueDiligenceWorkspaceId}/invoices/${ids.sentInvoiceId}`,
      prepare: "await-invoice-entries",
      readyText: markers.sentInvoiceNumber,
    },
    {
      // The Export Review table with its export menu open.
      name: "import-export",
      path: `/workspaces/${ids.exportReviewWorkspaceId}/`,
      prepare: "open-table-export",
      readyText: markers.exportReviewMatterName,
    },
    // The results listing without a query: every seeded decision of the
    // country, in the listing's own order. A keyword query depends on what
    // the best-effort seed search index matched and returned no rows in CI.
    ...(caseLawSearchCountry === null
      ? []
      : [
          {
            name: "case-law-search",
            path: `/law/cases?country=${caseLawSearchCountry.toLowerCase()}`,
            prepare: "await-search-results",
            country: caseLawSearchCountry,
            readyText: uiText(locale, "common.caseLaw"),
            clip: { x: 0, y: 0, width: 1440, height: 760 },
          } as const,
        ]),
  ] as const;
};

// Stills share the recordings' device pixel ratio, so the PNGs are twice the
// CSS clip size and stay sharp on retina screens. Clips stay in CSS pixels.
test.use({ deviceScaleFactor: CAPTURE_DPR });

// One test per locale firm: each signs in as that firm's owner with the
// browser in the firm's language, and writes `{name}{suffix}{-dark}.png`
// (English keeps the unsuffixed names; Czech `-cs`, Slovak `-sk`).
for (const locale of MARKETING_LOCALES) {
  const account = MARKETING_LOCALE_ACCOUNTS[locale];
  test.describe(locale, () => {
    test.use({ locale: account.browserLocale });

    test(`capture landing product screenshots (${locale})`, async ({
      context,
      page,
      request,
    }) => {
      await captureLocale({ context, locale, page, request });
    });
  });
}

type CaptureLocaleOptions = {
  context: BrowserContext;
  locale: MarketingLocale;
  page: Page;
  request: APIRequestContext;
};

const captureLocale = async ({
  context,
  locale,
  page,
  request,
}: CaptureLocaleOptions) => {
  const account = MARKETING_LOCALE_ACCOUNTS[locale];
  const ids = marketingSeedIds(locale);
  const captures = capturesFor(locale);
  const editLock = {
    ...MARKETING_URLS,
    supplierAgreement: ids.supplierAgreement,
  };
  await authenticateMarketingSession(request, locale);
  const { cookies } = await request.storageState();
  await context.addCookies(cookies);

  // The active organization is set server-side in authenticateMarketingSession
  // (via better-auth's set-active endpoint), so the workspace routes below are
  // already org-scoped — no org-picker UI to drive. Land on a real page first:
  // a fresh page sits on about:blank, where the localStorage access in the
  // theme loop below throws a SecurityError.
  await page.goto("/law", { waitUntil: "domcontentloaded" });
  // Choose the language the way the language picker does: its persisted
  // store, which every later navigation boots from. The browser locale
  // (test.use above) already matches, for regional formatting.
  await page.evaluate(
    ([storageKey, lang]) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ state: { lang }, version: 0 }),
      );
    },
    [I18N_STORAGE_KEY, locale] as const,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  // `domcontentloaded` only means the document parsed; on a cold dev server the
  // client still has to compile and hydrate the app before anything but the
  // splash paints (measured at ~11s locally, several times that on a CI
  // runner). Absorb that one-time cost here so the per-capture waits below
  // only ever cover a route transition.
  await expect(page.locator("main").first()).toBeVisible({
    timeout: COLD_COMPILE_TIMEOUT,
  });
  await expect(
    page.getByText(uiText(locale, "common.legalDatabase")).first(),
  ).toBeVisible({
    timeout: COLD_COMPILE_TIMEOUT,
  });

  // Start from no edit lock: a lock left by an earlier run would badge the
  // Supplier Agreement row in the workspace shot.
  await releaseSupplierAgreementEditLock(page.request, editLock);

  // Resolved once (not per capture/theme): only needed when the "agent"
  // capture is actually part of this run.
  const agentThreadPath =
    !requestedCapture || requestedCapture === "agent"
      ? await resolveAgentThreadPath(page.request, locale)
      : undefined;

  const decisionPaths =
    !requestedCapture || requestedCapture.startsWith("story-public-data-")
      ? await resolveDecisionPaths(page.request, locale)
      : new Map<string, string>();

  // The workspace tabs carry their views' names, which the API localizes
  // for the reader's language.
  const viewTabName = async (
    workspaceId: string,
    layoutType: "filesystem" | "table",
  ) =>
    await resolveViewName({
      layoutType,
      locale,
      request: page.request,
      workspaceId,
    });

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
        // A reader films a published decision page; the listing films
        // public search.
        const isPublic =
          capture.prepare === "open-decision"
            ? isPublicCaseLawPageCountry(capture.country)
            : isPublicCaseLawCountry(capture.country);
        expect(
          isPublic,
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
          .getByRole("button", {
            exact: true,
            name: uiText(locale, "inspector.showPane"),
          })
          .click();
        const scenario = MARKETING_CASE_LAW[locale].find(
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
        await page
          .getByRole("tab", {
            name: await viewTabName(ids.meridianWorkspaceId, "filesystem"),
          })
          .click();
        await expect(page).toHaveURL(
          new RegExp(`/workspaces/${ids.meridianWorkspaceId}/[^/?]+`, "u"),
        );
        const markers = MARKETING_LOCALE_MARKERS[locale];
        await expect(
          page.getByText(markers.safeAgreementFileName).first(),
        ).toBeVisible();
        // Both themes must show the same rows: no document carries an edit
        // lock badge (the editor capture releases its lock below).
        await expect(
          page.getByText(markers.supplierAgreementFileName).first(),
        ).toBeVisible();
        await assertNoActiveEditBadge(page, capture.name);
      }
      if ("prepare" in capture && capture.prepare === "open-table") {
        await page
          .getByRole("tab", {
            name: await viewTabName(ids.exportReviewWorkspaceId, "table"),
          })
          .click();
        await expect(page.getByRole("grid")).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "await-time-entries") {
        // The total row renders only once the day's entries have loaded.
        await expect(
          page
            .getByText(uiText(locale, "billing.total"), { exact: true })
            .first(),
        ).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "await-invoice-entries") {
        await expect(
          page.getByText(uiText(locale, "billing.invoices.linkedTimeEntries")),
        ).toBeVisible();
        await expect(page.locator("table tbody tr").first()).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "open-table-export") {
        await page
          .getByRole("tab", {
            name: await viewTabName(ids.exportReviewWorkspaceId, "table"),
          })
          .click();
        await expect(page.getByRole("grid")).toBeVisible();
        await page
          .getByRole("button", {
            exact: true,
            name: uiText(locale, "workspaces.views.exportTable"),
          })
          .first()
          .click();
        await expect(
          page.getByRole("menuitem", {
            name: uiText(locale, "workspaces.views.exportXlsx"),
          }),
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
          locale,
        });
      }
      await page.locator("body").waitFor({ state: "visible" });
      await page.evaluate(async () => document.fonts.ready);
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
      const fileName = `${capture.name}${account.captureSuffix}${themeSuffix}.png`;
      // Soft, so one run reports every drifted capture; a hard assertion
      // aborts the loop at the first mismatch and hides the rest until the
      // next run.
      await expect.soft(page).toHaveScreenshot(fileName, {
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
        await releaseSupplierAgreementEditLock(page.request, editLock);
      }
    }
  }
};

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
const resolveAgentThreadPath = async (
  request: APIRequestContext,
  locale: MarketingLocale,
) => {
  const response = await request.get(
    `${MARKETING_URLS.apiUrl}/v1/chat/threads?limit=50`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  const threadId = getMarketingAgentThreadId(await response.json(), locale);
  if (!threadId) {
    throw new Error(
      `Could not find the seeded "${MARKETING_LOCALE_MARKERS[locale].agent.threadTitle}" ` +
        "thread for the agent screenshot",
    );
  }
  return `/chat/workspaces/${marketingSeedIds(locale).exportReviewWorkspaceId}/${threadId}`;
};

const viewListSchema = v.array(
  v.looseObject({
    name: v.string(),
    layout: v.looseObject({ type: v.string() }),
  }),
);

type ResolveViewNameOptions = {
  layoutType: "filesystem" | "table";
  locale: MarketingLocale;
  request: APIRequestContext;
  workspaceId: string;
};

/** The name a workspace's default view of this layout shows in its tab. */
const resolveViewName = async ({
  layoutType,
  locale,
  request,
  workspaceId,
}: ResolveViewNameOptions) => {
  const response = await request.get(
    `${MARKETING_URLS.apiUrl}/v1/views/${workspaceId}`,
    { headers: { "Accept-Language": locale } },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const view = v
    .parse(viewListSchema, await response.json())
    .find(({ layout }) => layout.type === layoutType);
  if (view === undefined) {
    throw new Error(`Workspace ${workspaceId} has no ${layoutType} view`);
  }
  return view.name;
};

const DECISION_THREAD_PAGE_LIMIT = 100;
const threadPageSchema = v.object({
  global: v.array(v.unknown()),
  nextCursor: v.nullable(v.string()),
});

// The threads endpoint lists newest first, so the seeded readers can sit
// beyond the first page on a busy dev account: follow its cursor to the end.
const resolveDecisionPaths = async (
  request: APIRequestContext,
  locale: MarketingLocale,
) => {
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
      return getMarketingDecisionPaths({ global }, MARKETING_CASE_LAW[locale]);
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

const authenticateMarketingSession = async (
  request: APIRequestContext,
  locale: MarketingLocale,
) => {
  const { email, organizationId } = MARKETING_LOCALE_ACCOUNTS[locale];
  const apiBaseURL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
  const webOrigin = new URL(
    process.env["E2E_WEB_URL"] ?? "http://localhost:3000",
  ).origin;
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
      data: { organizationId },
      headers: { origin: webOrigin },
    },
  );
  expect(setActiveResponse.ok(), await setActiveResponse.text()).toBe(true);
};
