import { chromium, request as playwrightRequest } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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
const VIEWPORT = { height: 720, width: 1280 } as const;
const execFileAsync = promisify(execFile);

type CaptureTheme = "dark" | "light";
type StoryCaptureId = "agent" | "editor" | "review" | "workspace";

type StoryCapture = {
  durationSeconds: number;
  id: StoryCaptureId;
  path: (views: MarketingViewRoutes) => string;
  prepare: (page: Page) => Promise<void>;
};

type MarketingViewRoutes = {
  agent: string;
  files: string;
  table: string;
};

const captures = [
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
] as const satisfies readonly StoryCapture[];

const main = async () => {
  await mkdir(MEDIA_DIR, { recursive: true });
  await rm(RAW_VIDEO_DIR, { force: true, recursive: true });
  await mkdir(RAW_VIDEO_DIR, { recursive: true });

  let cookies = await authenticate();
  const browser = await chromium.launch({ headless: true });
  cookies = await selectMarketingOrganization(browser, cookies);
  const views = await resolveMarketingViewRoutes(browser, cookies);

  for (const theme of ["light", "dark"] as const) {
    if (THEME_FILTER && theme !== THEME_FILTER) {
      continue;
    }
    for (const capture of captures) {
      if (CAPTURE_FILTER && capture.id !== CAPTURE_FILTER) {
        continue;
      }
      await recordCapture({ browser, capture, cookies, theme, views });
    }
  }

  await browser.close();
  await rm(RAW_VIDEO_DIR, { force: true, recursive: true });
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
  const context = await createRecordingContext({ browser, cookies, theme });
  const page = await context.newPage();
  configurePage(page);
  const recordingStartedAt = performance.now();

  await page.goto(capture.path(views), { waitUntil: "commit" });
  await capture.prepare(page);
  await hideCaptureNoise(page);
  await page.evaluate(async () => document.fonts.ready);
  await page.waitForTimeout(450);
  const trimStartSeconds = (performance.now() - recordingStartedAt) / 1000;

  await replayCaptureMotion(page, capture.id);
  await page.waitForTimeout(capture.durationSeconds * 1000);

  const video = page.video();
  if (!video) {
    throw new Error(`Video recording did not start for ${capture.id}`);
  }

  await page.close();
  const suffix = theme === "dark" ? "-dark" : "";
  const rawPath = path.join(RAW_VIDEO_DIR, `${capture.id}${suffix}.webm`);
  const outputPath = path.join(MEDIA_DIR, `story-${capture.id}${suffix}.mp4`);
  const posterPath = path.join(
    MEDIA_DIR,
    `story-${capture.id}${suffix}-poster.jpg`,
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
  cookies: AuthCookie[];
  theme: CaptureTheme;
};

const createRecordingContext = async ({
  browser,
  cookies,
  theme,
}: RecordingContextOptions) => {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    colorScheme: theme,
    locale: "en-GB",
    recordVideo: { dir: RAW_VIDEO_DIR, size: VIEWPORT },
    viewport: VIEWPORT,
  });
  await context.addCookies(cookies);
  await context.addInitScript((nextTheme) => {
    localStorage.setItem("theme", nextTheme);
  }, theme);
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
    viewport: VIEWPORT,
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

const getMarketingAgentThreadId = (payload: unknown): string | undefined => {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("workspaces" in payload) ||
    !Array.isArray(payload.workspaces)
  ) {
    return undefined;
  }

  for (const workspace of payload.workspaces) {
    if (
      !workspace ||
      typeof workspace !== "object" ||
      !("threads" in workspace) ||
      !Array.isArray(workspace.threads)
    ) {
      continue;
    }
    for (const thread of workspace.threads) {
      if (
        thread &&
        typeof thread === "object" &&
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
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!("id" in value) || typeof value.id !== "string") {
    return false;
  }
  if (
    !("layout" in value) ||
    !value.layout ||
    typeof value.layout !== "object"
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
  const { otp } = await otpResponse.json();
  const signInResponse = await request.post(
    `${API_URL}/api/auth/sign-in/email-otp`,
    {
      data: { email: EMAIL, otp },
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
        if (
          group instanceof HTMLElement &&
          label?.textContent?.trim() === "Recent chats"
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

const closeInspectorIfOpen = async (page: Page) => {
  const closeButton = page.getByRole("button", { name: /close/i }).last();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
    await page.waitForTimeout(500);
  }
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
  if (captureId === "editor") {
    await animateDocumentScroll(page);
    return;
  }
  if (captureId === "agent") {
    await page
      .getByText(/atlas_001_Corporate/u)
      .first()
      .click();
    await page.waitForTimeout(2800);
    await page
      .getByText(/atlas_005_Finance/u)
      .first()
      .click();
  }
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
      "-crf",
      "27",
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
