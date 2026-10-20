/**
 * Closing Settings while it records the clipboard shortcut must leave the app
 * responsive: the close re-registers the paused shortcut, and that must not
 * block the main thread.
 *
 * Drives a running debug build through its embedded WebDriver server: start
 * the app with `STELLA_WEBDRIVER_OPEN=settings bun run dev --features
 * webdriver`, then `bun run test:webdriver`.
 */
import { panic } from "better-result";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const WEBDRIVER_URL = `http://127.0.0.1:${process.env["TAURI_WEBDRIVER_PORT"] ?? "4445"}`;
const STEP_BUDGET_MS = 30_000;
const RESPONSIVE_BUDGET_MS = 5000;
const POLL_INTERVAL_MS = 100;
const LANGUAGES_DIR = path.join(import.meta.dir, "../../src/i18n/langs");
const REGISTRATION_PAUSED = "paused";

const main = async () => {
  const changeLabels = translations("change");
  const sessionId = await createSession();
  const probe = await openProbeWindow(sessionId);
  await findWindow(sessionId, changeLabels);
  if (!(await clickButton(sessionId, changeLabels))) {
    panic("Settings shows no button to change the clipboard shortcut.");
  }
  await waitFor(
    async () => (await registration(sessionId)) === REGISTRATION_PAUSED,
    "the shortcut to pause for recording",
  );
  await command({
    method: "DELETE",
    path: `/session/${sessionId}/window`,
    budgetMs: STEP_BUDGET_MS,
  });
  await command({
    body: { handle: probe },
    method: "POST",
    path: `/session/${sessionId}/window`,
    budgetMs: RESPONSIVE_BUDGET_MS,
  });
  // Evaluating script needs the main thread, which a blocked close would hold.
  const answer = await command({
    body: { args: [], script: "return 1;" },
    method: "POST",
    path: `/session/${sessionId}/execute/sync`,
    budgetMs: RESPONSIVE_BUDGET_MS,
  });
  if (answer !== 1) {
    panic(`The app answered ${JSON.stringify(answer)} instead of 1.`);
  }
  await command({
    method: "DELETE",
    path: `/session/${sessionId}`,
    budgetMs: STEP_BUDGET_MS,
  });
};

type CommandOptions = {
  body?: Record<string, unknown>;
  budgetMs: number;
  method: "DELETE" | "GET" | "POST";
  path: string;
};

/** One W3C WebDriver command; its `value`, or a panic naming the failure. */
const command = async ({
  body,
  budgetMs,
  method,
  path: commandPath,
}: CommandOptions) => {
  const response = await fetch(`${WEBDRIVER_URL}${commandPath}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
    signal: AbortSignal.timeout(budgetMs),
  });
  const payload: unknown = await response.json();
  const value = isRecord(payload) ? payload["value"] : undefined;
  if (!response.ok) {
    panic(`${method} ${commandPath} failed: ${JSON.stringify(value)}`);
  }
  return value;
};

const createSession = async () => {
  const value = await command({
    body: { capabilities: { alwaysMatch: {} } },
    method: "POST",
    path: "/session",
    budgetMs: STEP_BUDGET_MS,
  });
  const sessionId = isRecord(value) ? value["sessionId"] : undefined;
  return typeof sessionId === "string"
    ? sessionId
    : panic("The WebDriver server returned no session id.");
};

/** A second window to probe from once Settings is gone. */
const openProbeWindow = async (sessionId: string) => {
  const value = await command({
    body: { type: "window" },
    method: "POST",
    path: `/session/${sessionId}/window/new`,
    budgetMs: STEP_BUDGET_MS,
  });
  const handle = isRecord(value) ? value["handle"] : undefined;
  return typeof handle === "string"
    ? handle
    : panic("The WebDriver server opened no probe window.");
};

/** Switches to the window that shows one of `labels` on a button. */
const findWindow = async (sessionId: string, labels: string[]) => {
  const handles = await command({
    method: "GET",
    path: `/session/${sessionId}/window/handles`,
    budgetMs: STEP_BUDGET_MS,
  });
  for (const handle of Array.isArray(handles) ? handles : []) {
    if (typeof handle !== "string") {
      continue;
    }
    await command({
      body: { handle },
      method: "POST",
      path: `/session/${sessionId}/window`,
      budgetMs: STEP_BUDGET_MS,
    });
    const found = await command({
      body: {
        args: [labels],
        script:
          "return [...document.querySelectorAll('button')].some((button) => arguments[0].includes(button.textContent.trim()));",
      },
      method: "POST",
      path: `/session/${sessionId}/execute/sync`,
      budgetMs: STEP_BUDGET_MS,
    });
    if (found === true) {
      return handle;
    }
  }
  return panic(
    "No window shows Settings; start the app with STELLA_WEBDRIVER_OPEN=settings.",
  );
};

const clickButton = async (sessionId: string, labels: string[]) =>
  (await command({
    body: {
      args: [labels],
      script:
        "const button = [...document.querySelectorAll('button')].find((candidate) => arguments[0].includes(candidate.textContent.trim())); button?.click(); return button !== undefined;",
    },
    method: "POST",
    path: `/session/${sessionId}/execute/sync`,
    budgetMs: STEP_BUDGET_MS,
  })) === true;

const registration = async (sessionId: string) =>
  command({
    body: {
      args: [],
      script:
        "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('shortcut_get_snapshot').then((snapshot) => done(snapshot.registration), () => done(null));",
    },
    method: "POST",
    path: `/session/${sessionId}/execute/async`,
    budgetMs: STEP_BUDGET_MS,
  });

const waitFor = async (check: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + STEP_BUDGET_MS;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  panic(`Timed out waiting for ${what}.`);
};

/** Every language's `shortcut.<key>` text, so the UI language does not matter. */
const translations = (key: string) =>
  readdirSync(LANGUAGES_DIR).flatMap((file) => {
    const messages: unknown = JSON.parse(
      readFileSync(path.join(LANGUAGES_DIR, file), "utf-8"),
    );
    const shortcut = isRecord(messages) ? messages["shortcut"] : undefined;
    const text = isRecord(shortcut) ? shortcut[key] : undefined;
    return typeof text === "string" ? [text] : [];
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

await main();
