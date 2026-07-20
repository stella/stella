// The e2e tsconfig is node-only (lib ESNext); the `page.evaluate` /
// `addInitScript` callbacks below run in the browser, so pull in the DOM
// lib for their globals (document, localStorage, MutationObserver, ...).
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { chromium, request as playwrightRequest } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Explicit .ts extension: `capture:product-story` runs this file under
// node's type stripping, whose ESM resolver requires real file paths.
import {
  CAPTURE_DPR,
  captureDefinitions,
  RECORDINGS_MANIFEST_PATH,
} from "./captures.ts";
import type {
  CaptureDefinition,
  CaptureTheme,
  CaptureViewport,
  RecordingManifestEntry,
  RecordingsManifest,
  StoryCaptureId,
} from "./captures.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MEDIA_DIR = path.join(REPO_ROOT, "apps/landing/public/media/products");
const RAW_VIDEO_DIR = path.join(REPO_ROOT, ".playwright/marketing-video");
const WEB_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const API_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const CAPTURE_FILTER = process.env["MARKETING_CAPTURE"];
const THEME_FILTER = process.env["MARKETING_THEME"];
const EMAIL = "test@stella.dev";
const MARKETING_AGENT_THREAD_TITLE = "Project Atlas · Change-of-control review";
const EXPORT_REVIEW_WORKSPACE_ID = "bb8641dc-0667-574c-8e30-152a1fd4b3f5";
const NORTHSTAR_WORKSPACE_ID = "6cbf3f81-bcc9-55da-8a4e-840221d4cabe";
// The wide/hero/portrait viewports and the capture matrix live in
// ./captures.ts so the staleness check (scripts/check-marketing-recordings.ts)
// shares one source of truth with the recorder.
const NAV_VIEWPORT = { height: 720, width: 1280 } as const;
const MANIFEST_PATH = path.join(REPO_ROOT, RECORDINGS_MANIFEST_PATH);
// eslint-disable-next-line typescript/strict-void-return -- promisify resolves execFile via its custom `__promisify__` overload; the rule matches the generic void-callback overload instead
const execFileAsync = promisify(execFile);

type StoryScene = {
  // Pre-collapse the app sidebar (icon rail) before the page loads; used by
  // the portrait document scene so the docx page fills the frame.
  collapsedSidebar?: boolean;
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
};

const scenes = [
  {
    id: "workspace",
    path: ({ files }) => files,
    durationSeconds: 4.8,
    prepare: async (page) => {
      await page
        .getByText("Export Review - Project Atlas Data Room")
        .first()
        .waitFor();
      await page
        .getByText(/atlas_001_Corporate/u)
        .first()
        .waitFor();
      await animateBetweenRows(page, /^Active$/u, /^Closed$/u);
    },
  },
  {
    id: "review",
    path: ({ table }) => table,
    durationSeconds: 4.8,
    prepare: async (page) => {
      await page
        .getByText("Export Review - Project Atlas Data Room")
        .first()
        .waitFor();
      await page.getByRole("grid").waitFor();
      await animateBetweenRows(page, /^Active$/u, /^In Review$/u);
    },
  },
  {
    id: "editor",
    path: () =>
      `/workspaces/${NORTHSTAR_WORKSPACE_ID}/all/document` +
      "?editing=true" +
      "&entity=c3596565-1663-57fe-81aa-e69a56675a27" +
      "&field=6a22b489-4a08-5c91-8cda-ec83ff6ef8e7",
    durationSeconds: 5.6,
    prepare: async (page) => {
      await page.getByText("Internal_SAFE_Agreement.docx").first().waitFor();
      await page.locator(".layout-run-text").first().waitFor();
      await closeInspectorIfOpen(page);
    },
  },
  {
    // Portrait-only document scene for the floating editor side window: the
    // same seeded SAFE in the document full view (the route the inspector's
    // "Full view" button opens), with the app sidebar collapsed so the Word
    // page fills the narrow frame.
    id: "editor-doc",
    collapsedSidebar: true,
    path: () =>
      `/workspaces/${NORTHSTAR_WORKSPACE_ID}/all/document` +
      "?editing=true" +
      "&entity=c3596565-1663-57fe-81aa-e69a56675a27" +
      "&field=6a22b489-4a08-5c91-8cda-ec83ff6ef8e7",
    durationSeconds: 5.6,
    prepare: async (page) => {
      await page.getByText("Internal_SAFE_Agreement.docx").first().waitFor();
      await page.locator(".layout-run-text").first().waitFor();
      await closeInspectorIfOpen(page);
    },
  },
  {
    id: "agent",
    path: ({ agent }) => agent,
    durationSeconds: 8,
    prepare: async (page) => {
      await page
        .getByText("Compare the change-of-control clauses across this matter.")
        .first()
        .waitFor();
      await page
        .getByText(/assignment or a material service change/u)
        .first()
        .waitFor();
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
    return { ...scene, ...definition};
  },
);

const captureFilter = CAPTURE_FILTER
  ? new Set(CAPTURE_FILTER.split(","))
  : undefined;

const main = async () => {
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

  for (const theme of ["light", "dark"] as const) {
    if (THEME_FILTER && theme !== THEME_FILTER) {
      continue;
    }
    for (const capture of captures) {
      if (captureFilter && !captureFilter.has(capture.captureId)) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- recordings are captured one scene at a time; a shared browser cannot record overlapping scenes
      await recordCapture({ browser, capture, cookies, theme, views });
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
    dpr: capture.dpr,
    theme,
    viewport: capture.viewport,
  });
  const page = await context.newPage();
  configurePage(page);
  const recordingStartedAt = performance.now();

  await page.goto(capture.path(views), { waitUntil: "commit" });
  await capture.prepare(page);
  await hideCaptureNoise(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(450);
  const trimStartSeconds = (performance.now() - recordingStartedAt) / 1000;

  await replayCaptureMotion(page, capture.id);
  await page.waitForTimeout(capture.durationSeconds * 1000);

  const video = page.video();
  if (!video) {
    throw new Error(`Video recording did not start for ${capture.captureId}`);
  }

  await page.close();
  const suffix = theme === "dark" ? "-dark" : "";
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

  await transcodeVideo({
    durationSeconds: capture.durationSeconds,
    outputPath,
    rawPath,
    trimStartSeconds,
  });
  await createVideoPoster({ outputPath, posterPath });
  process.stdout.write(`recorded ${path.relative(REPO_ROOT, outputPath)}\n`);
};

type RecordingContextOptions = {
  browser: Browser;
  collapsedSidebar: boolean;
  cookies: AuthCookie[];
  dpr: number;
  theme: CaptureTheme;
  viewport: CaptureViewport;
};

const createRecordingContext = async ({
  browser,
  collapsedSidebar,
  cookies,
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
  return context;
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
  const organization = page.getByRole("button", { name: /Test Firm/u });
  await organization.waitFor({ state: "visible" });
  const initialViewsRequest = page
    .waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes(`/v1/views/${EXPORT_REVIEW_WORKSPACE_ID}`),
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  await organization.click();
  await page.waitForURL(
    (url) => !url.pathname.startsWith("/auth/organization"),
    { waitUntil: "commit" },
  );
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
  await context.close();

  if (!filesView || !tableView || !threadId) {
    throw new Error(
      "The seeded marketing workspace is missing Files, Table, or its agent story",
    );
  }

  return {
    agent: `/chat/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/${threadId}`,
    files: `/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/${filesView.id}`,
    table: `/workspaces/${EXPORT_REVIEW_WORKSPACE_ID}/${tableView.id}`,
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

const authenticate = async () => {
  const request = await playwrightRequest.newContext();
  const origin = new URL(WEB_URL).origin;
  const sendResponse = await request.post(
    `${API_URL}/api/auth/email-otp/send-verification-otp`,
    {
      data: { email: EMAIL, type: "sign-in" },
      headers: { origin },
    },
  );
  if (!sendResponse.ok()) {
    throw new Error(await sendResponse.text());
  }

  const otpResponse = await request.get(
    `${API_URL}/dev-public/last-otp?email=${encodeURIComponent(EMAIL)}`,
  );
  if (!otpResponse.ok()) {
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
  const signInResponse = await request.post(
    `${API_URL}/api/auth/sign-in/email-otp`,
    {
      data: { email: EMAIL, otp: otpPayload.otp },
      headers: { origin },
    },
  );
  if (!signInResponse.ok()) {
    throw new Error(await signInResponse.text());
  }

  const { cookies } = await request.storageState();
  await request.dispose();
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

const animateBetweenRows = async (
  page: Page,
  firstRowText: RegExp,
  secondRowText: RegExp,
) => {
  await page.getByText(firstRowText).first().hover();
  await page.waitForTimeout(750);
  await page.getByText(secondRowText).first().hover();
};

// The inspector opens store-driven (async, after the document mounts), so a
// visibility snapshot races it: wait for its Close button to appear, close,
// and wait for the pane to leave so the document reflows to full width.
const closeInspectorIfOpen = async (page: Page) => {
  const closeButton = page.getByRole("button", { name: /^close$/iu }).last();
  const appeared = await closeButton
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    return;
  }
  await closeButton.click();
  await closeButton
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => undefined);
  await page.waitForTimeout(500);
};

const animateDocumentScroll = async (page: Page) => {
  await page
    .locator(".layout-run-text")
    .first()
    .evaluate((text) => {
      let scrollParent = text.parentElement;
      while (scrollParent) {
        if (scrollParent.scrollHeight > scrollParent.clientHeight + 40) {
          scrollParent.scrollTo({ behavior: "smooth", top: 180 });
          return;
        }
        scrollParent = scrollParent.parentElement;
      }
    });
};

const replayCaptureMotion = async (page: Page, captureId: StoryCaptureId) => {
  if (captureId === "workspace") {
    await animateBetweenRows(page, /^Closed$/u, /^Active$/u);
    return;
  }
  if (captureId === "review") {
    await animateBetweenRows(page, /^In Review$/u, /^Closed$/u);
    return;
  }
  if (captureId === "editor" || captureId === "editor-doc") {
    await animateDocumentScroll(page);
    return;
  }
  // Only "agent" remains.
  await page
    .getByText(/atlas_001_Corporate/u)
    .first()
    .click();
  await page.waitForTimeout(2800);
  await page
    .getByText(/atlas_005_Finance/u)
    .first()
    .click();
};

type TranscodeVideoOptions = {
  durationSeconds: number;
  outputPath: string;
  rawPath: string;
  trimStartSeconds: number;
};

const transcodeVideo = async ({
  durationSeconds,
  outputPath,
  rawPath,
  trimStartSeconds,
}: TranscodeVideoOptions) => {
  await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      trimStartSeconds.toFixed(3),
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
      // CRF 23 keeps 2x UI text legible; the old 1x captures used 27, which
      // reads soft on the fine strokes of retina-density text.
      "-crf",
      "23",
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
      "-ss",
      "0.300",
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
