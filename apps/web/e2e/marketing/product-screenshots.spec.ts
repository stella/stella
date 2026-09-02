import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

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
// Duplicated from apps/web/src/consts.ts, exactly as
// apps/web/public/prepaint-init.js duplicates it: the e2e project has no
// `@/` path alias. Writing any other key silently leaves the app on its
// system colour-scheme preference.
const THEME_STORAGE_KEY = "stella-ui-theme";
const requestedCapture = process.env["MARKETING_CAPTURE"];

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
  // HomeProductStory.astro's data chapter.
  {
    name: "story-public-data-1",
    prepare: "open-decision",
    decisionText: "IV.ÚS 1394/24",
    readyText: "Case Law",
    clip: { x: 0, y: 0, width: 1440, height: 760 },
  },
  {
    name: "story-public-data-2",
    prepare: "open-decision",
    decisionText: "IV C 1273/16",
    readyText: "Case Law",
    clip: { x: 0, y: 0, width: 1440, height: 760 },
  },
  {
    name: "story-public-data-3",
    prepare: "open-decision",
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
    readySelector: ".layout-run-text",
    // `?editing=true` is a request, not a state: without this the shot can
    // land on the read-only viewer while the editor is still unlocking.
    readyControl: { role: "button", name: "Finish editing" },
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
    decisionText: "IV.ÚS 1394/24",
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
    // eslint-disable-next-line no-await-in-loop -- captures reuse one authenticated page, so each theme switch and capture must be prepared and shot in order
    await page.emulateMedia({ colorScheme: theme });
    // Pin the stored theme as well as the media preference. localStorage is
    // origin-scoped, so this survives the navigations below; both inputs must
    // agree because prepaint-init.js reads the stored value first and only
    // falls back to the media query.
    // eslint-disable-next-line no-await-in-loop -- see above
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
      // A decision capture searches for its own decision: `/law/cases` with
      // nothing to show results for redirects to the home, and only a
      // searched decision is deterministically on screen.
      const searchedPath =
        "decisionText" in capture
          ? `/law/cases?q=${encodeURIComponent(capture.decisionText)}`
          : undefined;
      const declaredPath = "path" in capture ? capture.path : agentThreadPath;
      const capturePath = searchedPath ?? declaredPath;
      if (!capturePath) {
        throw new Error(`${capture.name}: no path resolved for this capture`);
      }
      // Anchor the inspector's relative timestamp before navigating, so the
      // caption paints with the pinned clock on its first render. Captures
      // without an anchor run on real time; the clock is only restored when a
      // previous capture actually pinned it, so the eight captures that never
      // show a timestamp keep an untouched Date/timer implementation.
      if ("versionAnchor" in capture) {
        // eslint-disable-next-line no-await-in-loop -- see above
        const versionCreatedAt = await resolveCurrentVersionCreatedAt(
          page.request,
          capture.versionAnchor,
        );
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.clock.setFixedTime(
          versionCreatedAt.getTime() + VERSION_CAPTION_OFFSET_MS,
        );
        clockPinned = true;
      } else if (clockPinned) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.clock.setSystemTime(Date.now());
        clockPinned = false;
      }
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.goto(capturePath, { waitUntil: "domcontentloaded" });
      // eslint-disable-next-line no-await-in-loop -- see above
      await expect(page).not.toHaveURL(/\/sign-in(?:\/|\?|$)/u);
      // Each capture is the first visit to its route, so its chunk compiles on
      // demand here too; the config's 15s expect timeout is not enough for that
      // on a CI runner.
      // eslint-disable-next-line no-await-in-loop -- see above
      await expect(page.getByText(capture.readyText).first()).toBeVisible({
        timeout: COLD_COMPILE_TIMEOUT,
      });
      if ("readySelector" in capture) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page.locator(capture.readySelector).first()).toBeVisible({
          timeout: COLD_COMPILE_TIMEOUT,
        });
      }
      if ("readyControl" in capture) {
        // A control that only exists in the target mode, so readiness asserts
        // the mode itself rather than the route that requested it.
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(
          page
            .getByRole(capture.readyControl.role, {
              name: capture.readyControl.name,
            })
            .first(),
        ).toBeVisible({ timeout: COLD_COMPILE_TIMEOUT });
      }
      if ("prepare" in capture && capture.prepare === "open-decision") {
        // Film a specific national decision deterministically, rather than
        // whatever happens to be newest in the seeded corpus.
        // eslint-disable-next-line no-await-in-loop -- see above
        await page
          .locator('main a[href*="/cases/"]')
          .filter({ hasText: capture.decisionText })
          .click();
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page).toHaveURL(/\/law\/[a-z-]+\/cases\//u);
        // The case detail is its own code-split chunk, so this click is the
        // first load of another route: same cold-compile allowance as the
        // navigations above, not the config's 15s default.
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page.locator("article").first()).toBeVisible({
          timeout: COLD_COMPILE_TIMEOUT,
        });
        // The reader briefly renders the logged-out workspace while the
        // client-side session query settles, then swaps in the authenticated
        // workspace. Wait for that swap before checking its generated outline.
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.waitForLoadState("networkidle");
        // The authenticated inspector is mounted beside this public route.
        // Catch route-context crashes at their boundary instead of timing out
        // later on whichever product control the error screen replaced.
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page.locator("#route-error-title")).toHaveCount(0);
        // These decisions have analysis cached server-side. Wait for the
        // automatic fetch so the capture never lands on the loading margin.
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(
          page.getByRole("group", { name: "Outline" }),
        ).toBeVisible();
        // The inspector chat loads its saved-skill prompts independently of
        // the decision and analysis queries. The empty state paints the logo
        // first, so waiting only for the reader can record a blank inspector.
        // Scope readiness to the visible inspector: other route shells may
        // remain mounted and must not satisfy the capture gate.
        const inspectorChat = page.locator(
          '[data-slot="inspector-chat-panel"]:visible',
        );
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(inspectorChat).toHaveCount(1, {
          timeout: COLD_COMPILE_TIMEOUT,
        });
        // This component only exists when at least one prompt card rendered.
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(
          inspectorChat.locator('[data-slot="prompt-suggestions"]'),
        ).toBeVisible({ timeout: COLD_COMPILE_TIMEOUT });
        // The first margin annotation may sit below a long headnote (e.g. a
        // Constitutional Court "legal sentence" summary); scroll it into view
        // so the capture shows the structure margin, not just headnote text.
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.locator("aside button").first().scrollIntoViewIfNeeded();
        // `scrollIntoViewIfNeeded` positions the nested reader correctly, but
        // can also move the document viewport. Restore only the outer viewport
        // so the breadcrumb remains in frame without undoing the reader scroll.
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.evaluate(() => window.scrollTo({ left: 0, top: 0 }));
      }
      if ("prepare" in capture && capture.prepare === "open-files") {
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.getByRole("tab", { name: "Files" }).click();
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page).toHaveURL(
          new RegExp(`/workspaces/${AKVIZICE_WORKSPACE_ID}/[^/?]+`, "u"),
        );
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(
          page.getByText("Internal_SAFE_Agreement.docx").first(),
        ).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "open-table") {
        // eslint-disable-next-line no-await-in-loop -- see above
        await page.getByRole("tab", { name: "Table" }).click();
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(page.getByRole("grid")).toBeVisible();
      }
      if ("prepare" in capture && capture.prepare === "open-agent-thread") {
        // The seeded thread already contains the full cited answer; wait for
        // it and one of its source chips so the shot never lands on a
        // pre-render/loading state (the empty /chat/new composer this
        // replaces had neither).
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(
          page.getByText(/assignment or a material service change/u).first(),
        ).toBeVisible();
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(
          page.getByText(/Aurora_Retail_Shareholder_Register_2018/u).first(),
        ).toBeVisible();
      }
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.locator("body").waitFor({ state: "visible" });
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.evaluate(async () => document.fonts.ready);
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.waitForTimeout(300);
      // eslint-disable-next-line no-await-in-loop -- see above
      await page.addStyleTag({
        content: `
          *, *::before, *::after {
            animation-delay: 0s !important;
            animation-duration: 0s !important;
            caret-color: transparent !important;
            transition-duration: 0s !important;
          }
          [data-sonner-toaster], [data-testid="devtools"] { display: none !important; }
        `,
      });

      const themeSuffix = theme === "dark" ? "-dark" : "";
      // Soft, so one run reports every drifted capture; a hard assertion
      // aborts the loop at the first mismatch and hides the rest until the
      // next run.
      // eslint-disable-next-line no-await-in-loop -- see above
      await expect
        .soft(page)
        .toHaveScreenshot(`${capture.name}${themeSuffix}.png`, {
          animations: "disabled",
          caret: "hide",
          clip:
            "clip" in capture
              ? capture.clip
              : { x: 255, y: 0, width: 1137, height: 710 },
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

  // The docked chat empty state only offers suggestions from installed
  // slash-command skills. Seed the same defaults a new user gets from the
  // Skills surface so fresh nightly databases record the intended prompt
  // cards instead of a permanently empty logo state.
  const seedSkillsResponse = await request.post(
    `${apiBaseURL}/v1/skills/seed`,
    {
      headers: { origin: webOrigin },
    },
  );
  expect(seedSkillsResponse.ok(), await seedSkillsResponse.text()).toBe(true);
};
