import { expect, test } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { isPublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import { setFixedBrowserTime } from "../helpers/clock";

const AKVIZICE_WORKSPACE_ID = "6cbf3f81-bcc9-55da-8a4e-840221d4cabe";
const EXPORT_REVIEW_WORKSPACE_ID = "bb8641dc-0667-574c-8e30-152a1fd4b3f5";
// Seeded Supplier Agreement redline in the "Meridian supply agreement"
// matter; keep in sync with record-product-story.ts (seed-dev.ts
// `ws-akvizice-energo-doc-7`).
const SUPPLIER_AGREEMENT_ENTITY_ID = "84824638-eb81-58c5-8a81-5d7e961fb7d5";
const SUPPLIER_AGREEMENT_FIELD_ID = "3f985a8b-26be-5a07-89d3-2a05acb94354";
// Seeded `Redacted_Due_Diligence_Extract.docx` in the same matter, opened by
// the anonymization capture.
const ANONYMIZED_EXTRACT_ENTITY_ID = "c3dc74a6-7855-5157-84db-ddf14f886df4";
const ANONYMIZED_EXTRACT_FIELD_ID = "e98a6746-dae9-5509-888b-d58bfbca9a33";
// Seeded "Change-of-control" thread in the Export Review matter (seed-dev.ts
// `marketing-agent-thread`), already containing the cited Q&A; keep in sync
// with record-product-story.ts's MARKETING_AGENT_THREAD_TITLE. Resolved by
// title via the chat threads API rather than a fixed thread id, mirroring
// the video recorder's resolveMarketingViewRoutes, so the agent screenshot
// never lands on the empty /chat/new composer.
const MARKETING_AGENT_THREAD_TITLE = "Project Atlas · Change-of-control review";
// The org that owns every seeded marketing workspace (AKVIZICE/EXPORT_REVIEW/
// Meridian). Fixed id from seed-utils' DEFAULT_ORG_ID ("Harbrook & Partners",
// apps/api/scripts/seed-test-user.ts), seeded by
// db:seed-test-user then populated by db:seed-dev. A fresh email-OTP sign-in
// starts with no active organization, so we set it server-side (below) instead
// of driving the org-picker UI, which the workspace routes below depend on.
const MARKETING_ORGANIZATION_ID = "test-org-stella-dev";
// The seeded reader story on the CZE decision (apps/api/scripts/
// seed-case-law-reader-story.ts, `CASE_LAW_READER_STORY`): the test user's
// highlights and comments on it, and its chat already holding a cited answer.
// The thread is found by this title; keep it in sync with `threadTitle`
// there. Filming another decision is a change to that constant plus a
// capture's `decisionText`.
const READER_STORY_THREAD_TITLE =
  "Director's guarantee under § 159(3): when it arises";
// Words from the seeded answer, proving it rendered rather than the empty
// chat's prompt cards.
const READER_STORY_ANSWER_TEXT = /No demand is needed/u;
// Where the framed paragraph lands below the reader's top edge: room for its
// section heading, and for the comment cards beside it to fit the clip.
const READER_SCROLL_OFFSET_PX = 48;
// The most air left above the block the frame opens on; less when the gap to
// the block above is smaller, so that block stays wholly out of view.
const READER_TOP_INSET_PX = 12;
// How many blocks, from the target's own upward, the frame may open on.
const READER_FRAME_CANDIDATES = 6;
// Duplicated from packages/api-contract/src/browser-storage.ts
// (`ownerStorageKey`) and apps/web/src/components/inspector/
// inspector-storage-keys.ts, for the same reason as the theme key below.
const INSPECTOR_STATE_STORAGE_PREFIX = "stella:inspector-state:v1:";
const INSPECTOR_MINIMIZED_STORAGE_PREFIX = "stella:inspector-minimized:v1:";
const USER_STORAGE_SEGMENT = ":u:";
// Duplicated from apps/web/src/consts.ts, exactly as
// apps/web/public/prepaint-init.js duplicates it: the e2e project has no
// `@/` path alias. Writing any other key silently leaves the app on its
// system colour-scheme preference.
const THEME_STORAGE_KEY = "stella-ui-theme";
const INSPECTOR_STORAGE_PREFIXES = [
  INSPECTOR_MINIMIZED_STORAGE_PREFIX,
  INSPECTOR_STATE_STORAGE_PREFIX,
] as const;
const requestedCapture = process.env["MARKETING_CAPTURE"];

// Route chunks are compiled on demand by the dev server, so the first visit to
// each route pays a cold build that the config's 15s expect timeout cannot
// cover on a CI runner. Mirrors the same allowance in e2e/specs/route-smoke.
const COLD_COMPILE_TIMEOUT = 60_000;

type CaptureClip = { x: number; y: number; width: number; height: number };
// What a capture without its own clip records.
const DEFAULT_CLIP: CaptureClip = { x: 255, y: 0, width: 1137, height: 710 };

// The document inspector renders `${versionLabel} · ${formatRelativeTime(...)}`
// against the current version's timestamp, so the caption changes with wall
// clock time and drifts every baseline it appears in. Captures carrying a
// `versionAnchor` pin the page clock this far past that timestamp, so the
// caption renders the same string on every run: five minutes sits well inside
// `formatRelativeTime`'s minute bucket (one minute to one hour), far from
// either boundary, and reads as a natural "just edited" label.
const VERSION_CAPTION_OFFSET_MS = 5 * 60_000;

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
  // Three different national decisions (CZE, POL, SVK), each rendering with
  // the structured reader (structure/AI margin populated) so the chapter can
  // cross-fade between jurisdictions. Keep in sync with
  // HomeProductStory.astro's data chapter. Only a publicly admitted country
  // is filmed (see the capture loop); a `readerStory` capture also shows the
  // seeded highlights, comments and cited chat answer.
  {
    name: "story-public-data-1",
    prepare: "open-decision",
    country: "CZE",
    decisionText: "27 Cdo 59/2022",
    readerStory: true,
    readyText: "Case Law",
    clip: { x: 0, y: 0, width: 1440, height: 760 },
  },
  {
    name: "story-public-data-2",
    prepare: "open-decision",
    country: "POL",
    decisionText: "IV C 1273/16",
    readyText: "Case Law",
    clip: { x: 0, y: 0, width: 1440, height: 760 },
  },
  {
    name: "story-public-data-3",
    prepare: "open-decision",
    country: "SVK",
    decisionText: "25Cbr/166/2024",
    readyText: "Case Law",
    clip: { x: 0, y: 0, width: 1440, height: 760 },
  },
  {
    name: "editor",
    path:
      `/workspaces/${AKVIZICE_WORKSPACE_ID}/all/document` +
      "?editing=true" +
      `&entity=${SUPPLIER_AGREEMENT_ENTITY_ID}` +
      `&field=${SUPPLIER_AGREEMENT_FIELD_ID}`,
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
    name: "agent",
    prepare: "open-agent-thread",
    // The question from the seeded thread; the answer and its source chips
    // are asserted separately in the "open-agent-thread" prepare block below
    // so the shot never ships mid-render.
    readyText: "Compare the change-of-control clauses across this matter.",
  },
  {
    name: "public-data",
    prepare: "open-decision",
    country: "CZE",
    decisionText: "27 Cdo 59/2022",
    readerStory: true,
    readyText: "Case Law",
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
] as const;

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

  // Resolved once (not per capture/theme): only needed when the "agent"
  // capture is actually part of this run.
  const agentThreadPath =
    !requestedCapture || requestedCapture === "agent"
      ? await resolveAgentThreadPath(page.request)
      : undefined;

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
      if ("country" in capture && !isPublicCaseLawCountry(capture.country)) {
        continue;
      }
      // A decision capture scopes the search to its country so only a
      // matching decision is deterministically on screen.
      const searchedPath =
        "decisionText" in capture
          ? `/law/cases?country=${capture.country.toLowerCase()}&q=${encodeURIComponent(
              capture.decisionText,
            )}`
          : undefined;
      const declaredPath = "path" in capture ? capture.path : agentThreadPath;
      const capturePath = searchedPath ?? declaredPath;
      if (!capturePath) {
        throw new Error(`${capture.name}: no path resolved for this capture`);
      }
      await clearPersistedInspectorState(page);
      // Anchor the inspector's relative timestamp before navigating, so the
      // caption paints with the pinned clock on its first render. Captures
      // without an anchor run on real time; the clock is only restored when a
      // previous capture actually pinned it, so the eight captures that never
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
      await page.goto(capturePath, { waitUntil: "domcontentloaded" });
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
        // Film a specific national decision deterministically, rather than
        // whatever happens to be newest in the seeded corpus.
        const decisionLink = page
          .locator('main a[href*="/cases/"]')
          .filter({ hasText: capture.decisionText });
        await expect(decisionLink).toBeVisible({
          timeout: COLD_COMPILE_TIMEOUT,
        });
        // A plain click on a results row opens that decision in the inspector
        // beside the results; this capture wants the full reader page, which
        // is what the row's own href names. Take the href rather than a
        // rebuilt path, so the shot follows the product's link even if the
        // decision route's shape changes.
        const decisionPath = await decisionLink.getAttribute("href");
        if (decisionPath === null) {
          throw new Error(
            `${capture.name}: the "${capture.decisionText}" result row has no href to the decision`,
          );
        }
        // The reader carries its own inspector, which must start from the same
        // clean state as every other capture rather than inheriting whatever
        // the results page persisted.
        await clearPersistedInspectorState(page);
        // A decision's chat tab restored from storage is that decision's
        // conversation; without one the reader mints an empty thread.
        const readerStoryThreadId =
          "readerStory" in capture
            ? await restoreReaderStoryChatTab(page, capture.decisionText)
            : undefined;
        await page.goto(decisionPath, { waitUntil: "commit" });
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
          page.getByRole("group", { name: "Outline" }),
        ).toBeVisible();
        // Decision routes intentionally seed their inspector tabs without
        // opening the pane. This capture includes the chat, so open it as an
        // explicit user action and assert the route honored that contract.
        const inspectorDock = page.locator('[data-slot="inspector-dock"]');
        await inspectorDock
          .getByRole("button", { exact: true, name: "Show pane" })
          .click();
        // Scope readiness to the visible inspector: other route shells may
        // remain mounted and must not satisfy the capture gate.
        const inspectorChat = page.locator(
          '[data-slot="inspector-chat-panel"]:visible',
        );
        await expect(inspectorChat).toHaveCount(1, {
          timeout: COLD_COMPILE_TIMEOUT,
        });
        if (readerStoryThreadId !== undefined) {
          // Name the failure precisely: a fresh thread here means the saved
          // tab was never restored, not that the answer is slow to render.
          await expect(
            inspectorChat,
            `The decision's chat pane should show the seeded thread ${readerStoryThreadId}, restored from the saved inspector tab, not a newly minted one`,
          ).toHaveAttribute("data-chat-thread-id", readerStoryThreadId);
          // The restored thread's cited answer, down to a citation chip, so
          // the shot never lands on the empty chat or a loading transcript.
          await expect(
            inspectorChat.getByText(READER_STORY_ANSWER_TEXT).first(),
          ).toBeVisible({ timeout: COLD_COMPILE_TIMEOUT });
          await expect(
            inspectorChat.locator("[data-decision-citation]").first(),
          ).toBeVisible({ timeout: COLD_COMPILE_TIMEOUT });
        } else {
          // The empty chat loads its saved-skill prompts independently of the
          // decision and analysis queries and paints the logo first; this
          // component only exists once at least one prompt card rendered.
          await expect(
            inspectorChat.locator('[data-slot="prompt-suggestions"]'),
          ).toBeVisible({ timeout: COLD_COMPILE_TIMEOUT });
        }
        // The decision opens on its headnote, with the body and its margin
        // further down. Scroll the reader's own scroller to the reader's first
        // mark (or, without one, the first AI note) so the shot shows the
        // body beside its margin rather than headnote text.
        const readerMark = page
          .locator('[data-slot="reader-document-column"] [data-annotation-id]')
          .first();
        await scrollReaderTo(
          "readerStory" in capture
            ? readerMark
            : page.locator(AI_MARGIN_NOTE_SELECTOR).first(),
        );
        const captureClip = "clip" in capture ? capture.clip : DEFAULT_CLIP;
        // Notes are placed beside their passages once the reader measured
        // them, so this also waits out that layout.
        await expectSomeWithinClip(
          page,
          AI_MARGIN_NOTE_SELECTOR,
          captureClip,
          "an AI margin note",
        );
        // Where a block or a stacked note meets the frame's edges depends on
        // the fonts the runner renders with, so the frame is chosen from
        // the measured layout, then every promise is checked again.
        await frameReader(page, {
          clip: captureClip,
          target:
            "readerStory" in capture
              ? readerMark
              : page.locator(AI_MARGIN_NOTE_SELECTOR).first(),
          needsComment: "readerStory" in capture,
        });
        await expectCleanTopEdge(page);
        // Whole notes, inside the shot's own clip: a card cut at the frame's
        // edge reads as a glitch.
        await expectSomeWithinClip(
          page,
          AI_MARGIN_NOTE_SELECTOR,
          captureClip,
          "an AI margin note",
        );
        if ("readerStory" in capture) {
          await expectWithinClip(
            readerMark,
            captureClip,
            "The first mark in the text",
          );
          await expectSomeWithinClip(
            page,
            '[data-margin-note="comment"] > *',
            captureClip,
            "a comment card",
          );
        }
        await expectNoMarginNoteCut(page, captureClip);
        // Keep the breadcrumb in frame: only the nested reader scrolls.
        await page.evaluate(() => window.scrollTo({ left: 0, top: 0 }));
      }
      if ("prepare" in capture && capture.prepare === "open-files") {
        await page.getByRole("tab", { name: "Files" }).click();
        await expect(page).toHaveURL(
          new RegExp(`/workspaces/${AKVIZICE_WORKSPACE_ID}/[^/?]+`, "u"),
        );
        await expect(
          page.getByText("Internal_SAFE_Agreement.docx").first(),
        ).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "open-table") {
        await page.getByRole("tab", { name: "Table" }).click();
        await expect(page.getByRole("grid")).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "open-agent-thread") {
        // The seeded thread already contains the full cited answer; wait for
        // it and one of its source chips so the shot never lands on a
        // pre-render/loading state (the empty /chat/new composer this
        // replaces had neither).
        await expect(
          page.getByText(/assignment or a material service change/u).first(),
        ).toBeVisible();
        await expect(
          page.getByText(/Aurora_Retail_Shareholder_Register_2018/u).first(),
        ).toBeVisible();
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
          scale: "css",
        });
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

// The AI's notes: a section card or a further note under it. The kind marker
// wraps each note with `display: contents`, so the note's own box is its
// child.
const AI_MARGIN_NOTE_SELECTOR =
  '[data-margin-note="card"] > *, [data-margin-note="annotation"] > *';

// Waits until at least one element matching `selector` lies wholly inside
// the recorded clip.
const expectSomeWithinClip = async (
  page: Page,
  selector: string,
  clip: CaptureClip,
  label: string,
) => {
  await expect
    .poll(
      async () =>
        await page.evaluate(
          ({ band, query }) =>
            [...document.querySelectorAll(query)].some((element) => {
              const box = element.getBoundingClientRect();
              return (
                box.height > 0 &&
                box.top >= band.y &&
                box.left >= band.x &&
                box.bottom <= band.y + band.height &&
                box.right <= band.x + band.width
              );
            }),
          { band: clip, query: selector },
        ),
      {
        message: `Expected ${label} wholly inside the ${String(clip.width)}x${String(clip.height)} capture clip`,
      },
    )
    .toBe(true);
};

// Waits until the element's whole box lies inside the recorded clip, so a
// note half past the frame's edge fails here, naming itself, rather than
// shipping in the shot.
const expectWithinClip = async (
  target: Locator,
  clip: CaptureClip,
  label: string,
) => {
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        return (
          box !== null &&
          box.y >= clip.y &&
          box.x >= clip.x &&
          box.y + box.height <= clip.y + clip.height &&
          box.x + box.width <= clip.x + clip.width
        );
      },
      {
        message: `${label} must lie wholly inside the ${String(clip.width)}x${String(clip.height)} capture clip`,
      },
    )
    .toBe(true);
};

// Chooses the reader's frame in one step, from measured positions. Every
// candidate opens on the start of a block at or above the target's block,
// with the block above it wholly out of view; the gap between two blocks is
// only a few pixels, so the frame's top edge sits inside that gap rather
// than at a fixed offset (a fixed offset larger than the gap would cut the
// block above, and lowering that one would cut the next). The first
// candidate that also holds an AI note clear of the margin's sticky header,
// the target, a whole comment card when the shot has one, and no note cut
// by either edge wins; the scroller moves once, by that candidate's offset.
// Notes are laid out against the scrolling content, so shifting a measured
// box by the offset is where it lands. Throws, naming each candidate's
// failure, when none fits.
const frameReader = async (
  page: Page,
  {
    clip,
    target,
    needsComment,
  }: { clip: CaptureClip; target: Locator; needsComment: boolean },
) => {
  await expect(target).toBeAttached({ timeout: COLD_COMPILE_TIMEOUT });
  await target.evaluate(
    (targetElement, { bandBottom, commentRequired, maxInset, candidates }) => {
      const column = document.querySelector(
        '[data-slot="reader-document-column"]',
      );
      const scroller = column?.closest(".reader-scroll");
      if (!column || !(scroller instanceof HTMLElement)) {
        throw new Error("The reader's scroller is missing");
      }
      const frame = scroller.getBoundingClientRect();
      const top = frame.top;
      const bottom = Math.min(frame.bottom, bandBottom);
      // Outermost blocks only: a table cell carries its own anchor inside
      // its table's.
      const blocks = [...column.querySelectorAll<HTMLElement>("[data-anchor]")]
        .filter(
          (block) => block.parentElement?.closest("[data-anchor]") === null,
        )
        .map((block) => block.getBoundingClientRect())
        .filter((box) => box.height > 0);
      const notes = [
        ...document.querySelectorAll<HTMLElement>("[data-margin-note] > *"),
      ].map((note) => ({
        box: note.getBoundingClientRect(),
        kind: note.parentElement?.dataset.marginNote ?? "",
      }));
      // The margin's current-section header sticks to the top of the
      // scroller; a note under it reads as cut.
      const aside = column.parentElement?.querySelector("aside");
      const stuck = aside
        ? [...aside.querySelectorAll<HTMLElement>("*")]
            .filter(
              (element) => getComputedStyle(element).position === "sticky",
            )
            .map((element) => element.getBoundingClientRect())
            .filter((box) => box.height > 0 && box.top <= top + 1)
        : [];
      const notesTop = Math.max(top, ...stuck.map((box) => box.bottom));
      const targetBox = targetElement.getBoundingClientRect();
      const targetBlock = blocks.findLastIndex(
        (box) => box.top <= targetBox.top + 1,
      );
      if (targetBlock < 1) {
        throw new Error("The target has no block above it to frame from");
      }
      const within = (box: DOMRect, delta: number, upper: number) =>
        box.top - delta >= upper && box.bottom - delta <= bottom;
      const crosses = (box: DOMRect, delta: number, edge: number) =>
        box.top - delta < edge && box.bottom - delta > edge;
      const failures: string[] = [];
      for (
        let index = targetBlock;
        index > Math.max(0, targetBlock - candidates);
        index -= 1
      ) {
        const block = blocks[index];
        const above = blocks[index - 1];
        if (!block || !above) {
          continue;
        }
        const gap = block.top - above.bottom;
        const inset = Math.max(0, Math.min(maxInset, gap - 1));
        const delta = block.top - (top + inset);
        const problems = [
          blocks.some((box) => crosses(box, delta, top))
            ? "a block crosses the top edge"
            : null,
          within(targetBox, delta, top) ? null : "the target is out of view",
          notes.some(
            ({ box, kind }) =>
              kind !== "comment" &&
              kind !== "composer" &&
              within(box, delta, notesTop),
          )
            ? null
            : "no AI note clear of the header",
          !commentRequired ||
          notes.some(
            ({ box, kind }) =>
              kind === "comment" && within(box, delta, notesTop),
          )
            ? null
            : "no whole comment card",
          notes.some(
            ({ box }) =>
              crosses(box, delta, notesTop) || crosses(box, delta, bottom),
          )
            ? "a note is cut by an edge"
            : null,
        ].filter((problem) => problem !== null);
        if (problems.length === 0) {
          scroller.scrollTop += delta;
          return;
        }
        failures.push(`block ${String(index)}: ${problems.join(", ")}`);
      }
      throw new Error(`No frame fits the reader shot: ${failures.join("; ")}`);
    },
    {
      bandBottom: clip.y + clip.height,
      commentRequired: needsComment,
      maxInset: READER_TOP_INSET_PX,
      candidates: READER_FRAME_CANDIDATES,
    },
  );
};

// No text block straddles the reader's top edge: the first one in view
// starts at or below it.
const expectCleanTopEdge = async (page: Page) => {
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const scroller = document
            .querySelector('[data-slot="reader-document-column"]')
            ?.closest(".reader-scroll");
          if (!(scroller instanceof HTMLElement)) {
            return "the reader's scroller is missing";
          }
          const top = scroller.getBoundingClientRect().top;
          const cut = [
            ...document.querySelectorAll<HTMLElement>(
              '[data-slot="reader-document-column"] [data-anchor]',
            ),
          ].find((block) => {
            const box = block.getBoundingClientRect();
            return box.top < top && box.bottom > top;
          });
          return cut === undefined
            ? null
            : `block ${cut.dataset.anchor ?? "?"} starts above the reader's top edge`;
        }),
      { message: "The reader's frame must open on the start of a block" },
    )
    .toBeNull();
};

// Every margin note is either wholly in the shot or wholly out of it: the
// visible band is where the reader's scroller and the clip overlap, and a
// note crossing either edge of it would ship half drawn.
const expectNoMarginNoteCut = async (page: Page, clip: CaptureClip) => {
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
            const top = Math.max(frame.top, band.top);
            const bottom = Math.min(frame.bottom, band.bottom);
            const cut: string[] = [];
            for (const note of document.querySelectorAll(
              "[data-margin-note] > *",
            )) {
              const box = note.getBoundingClientRect();
              const overlaps = box.bottom > top && box.top < bottom;
              if (overlaps && (box.top < top || box.bottom > bottom)) {
                const kind = note.parentElement?.dataset.marginNote ?? "?";
                cut.push(
                  `${kind} note "${(note.textContent ?? "").slice(0, 40)}" spans ${String(Math.round(box.top))}-${String(Math.round(box.bottom))}`,
                );
              }
            }
            return cut;
          },
          { top: clip.y, bottom: clip.y + clip.height },
        ),
      {
        message: `No margin note may be cut by the ${String(clip.height)}px capture's visible band`,
      },
    )
    .toEqual([]);
};

// Scrolls the reader's own scroller, never the page, so the target's passage
// sits a fixed distance below the reader's top edge: one deterministic
// position rather than wherever `scrollIntoView` settles. A mark is inline,
// so the passage framed is the text block it sits in.
const scrollReaderTo = async (target: Locator) => {
  await expect(target).toBeAttached({ timeout: COLD_COMPILE_TIMEOUT });
  await target.evaluate((element, offset) => {
    const scroller = element.closest(".reader-scroll");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("The scroll target is outside the reader's scroller");
    }
    const framed = element.closest("[data-anchor]") ?? element;
    scroller.scrollTop +=
      framed.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      offset;
  }, READER_SCROLL_OFFSET_PX);
};

// Persists the inspector state a returning reader would have: the decision's
// chat tab, bound to the seeded thread. The inspector restores it as the
// decision's conversation, so the reader adopts the seeded thread instead of
// minting an empty one.
const restoreReaderStoryChatTab = async (page: Page, caseNumber: string) => {
  const apiBaseURL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
  const sessionResponse = await page.request.get(
    `${apiBaseURL}/api/auth/get-session`,
  );
  expect(sessionResponse.ok(), await sessionResponse.text()).toBe(true);
  const userId = getSessionUserId(await sessionResponse.json());
  if (userId === undefined) {
    throw new Error("The marketing session has no signed-in user");
  }
  const threadsResponse = await page.request.get(
    `${apiBaseURL}/v1/chat/threads?limit=50&search=${encodeURIComponent(
      READER_STORY_THREAD_TITLE,
    )}`,
  );
  expect(threadsResponse.ok(), await threadsResponse.text()).toBe(true);
  const thread = getReaderStoryThread(await threadsResponse.json(), caseNumber);
  if (thread === undefined) {
    throw new Error(
      `Could not find the seeded "${READER_STORY_THREAD_TITLE}" thread on ` +
        `${caseNumber}; run the dev seed (seed-case-law-reader-story.ts)`,
    );
  }
  const ownerSuffix = `${MARKETING_ORGANIZATION_ID}:${USER_STORAGE_SEGMENT}${userId}`;
  await page.evaluate(
    ({ minimizedKey, storageKey, state }) => {
      localStorage.setItem(storageKey, JSON.stringify(state));
      // The pane folded, as a reader who left it that way would find it:
      // a restored inspector keeps its stored pane state, and the capture
      // opens the pane itself.
      localStorage.setItem(minimizedKey, "1");
    },
    {
      minimizedKey: `${INSPECTOR_MINIMIZED_STORAGE_PREFIX}${ownerSuffix}`,
      storageKey: `${INSPECTOR_STATE_STORAGE_PREFIX}${ownerSuffix}`,
      // The shape readPersistedInspectorState (inspector-broadcast.ts)
      // accepts; a chat tab with an `activeLegalKey` is that document's chat.
      state: {
        tabs: [
          {
            type: "chat",
            id: thread.threadId,
            label: READER_STORY_THREAD_TITLE,
            contextMatterIds: [],
            activeLegalKey: `decision:${thread.decisionId}`,
          },
        ],
        groups: [],
        groupAssignments: {},
        activeId: thread.threadId,
        collapsedGroupIds: [],
      },
    },
  );
  return thread.threadId;
};

const getSessionUserId = (payload: unknown): string | undefined => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("user" in payload) ||
    typeof payload.user !== "object" ||
    payload.user === null ||
    !("id" in payload.user) ||
    typeof payload.user.id !== "string"
  ) {
    return undefined;
  }
  return payload.user.id;
};

// The global thread with the story's title whose decision badge names the
// filmed decision; the badge also carries the id the chat tab binds to.
const getReaderStoryThread = (
  payload: unknown,
  caseNumber: string,
): { threadId: string; decisionId: string } | undefined => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("global" in payload) ||
    !isUnknownArray(payload.global)
  ) {
    return undefined;
  }
  for (const thread of payload.global) {
    if (
      typeof thread !== "object" ||
      thread === null ||
      !("id" in thread) ||
      typeof thread.id !== "string" ||
      !("title" in thread) ||
      thread.title !== READER_STORY_THREAD_TITLE ||
      !("decision" in thread) ||
      typeof thread.decision !== "object" ||
      thread.decision === null ||
      !("badge" in thread.decision) ||
      typeof thread.decision.badge !== "object" ||
      thread.decision.badge === null
    ) {
      continue;
    }
    const { badge } = thread.decision;
    if (
      "id" in badge &&
      typeof badge.id === "string" &&
      "caseNumber" in badge &&
      badge.caseNumber === caseNumber
    ) {
      return { threadId: thread.id, decisionId: badge.id };
    }
  }
  return undefined;
};

// Resolves the seeded agent thread's route by title via the chat threads
// API (same lookup as record-product-story.ts's
// resolveMarketingViewRoutes/getMarketingAgentThreadId), instead of a fixed
// thread id that would need updating whenever the dev seed reruns.
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
    { data: { email, otp }, headers: { origin: webOrigin } },
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
