import type { APIRequestContext, Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  LOCAL_RUNNER_LINK_FILE,
  LOCAL_RUNNER_SWITCHES,
  localRunnerDir,
} from "@stll/scripts/src/agent-local-runner-files";

import { apiGet } from "../helpers/api";
import { expect } from "../helpers/test";
import {
  PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  PLAYWRIGHT_EXPECT_TIMEOUT_60_SECONDS_MS,
} from "../helpers/wait-budgets";

// The stand-in computer the suite drives (started by
// `packages/scripts/src/e2e-local-runner.ts` or `agent:up -- --local-runner`)
// and the page objects for choosing where a chat runs. Only `chooseRunOn` and
// `choosePermission` know how the composer offers that choice.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const STATE_DIR = localRunnerDir(REPO_ROOT);

export const AGENTS = {
  codex: { name: "Codex", log: "codex.log" },
  "claude-code": { name: "Claude Code", log: "claude-code.log" },
} as const;
export type Agent = keyof typeof AGENTS;

export type RunOn =
  { place: "cloud" } | { place: "computer"; agent: Agent; model: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const THREAD_URL = new RegExp(`/chat/${UUID}$`, "u");

// ── The stand-in computer ──────────────────────────────────────────────

const linkSchema = v.object({ desktopId: v.string() });

const desktopId = () =>
  v.parse(
    linkSchema,
    JSON.parse(
      readFileSync(path.join(STATE_DIR, LOCAL_RUNNER_LINK_FILE), "utf-8"),
    ),
  ).desktopId;

const runnersSchema = v.variant("status", [
  v.object({ status: v.literal("hidden") }),
  v.object({
    status: v.literal("enabled"),
    runners: v.array(
      v.looseObject({ desktopId: v.string(), connected: v.boolean() }),
    ),
  }),
]);

/** Whether the API sees the stand-in computer connected. */
const isConnected = async (request: APIRequestContext) => {
  const answer = v.parse(
    runnersSchema,
    await apiGet(request, "/chat/local-runners"),
  );
  const id = desktopId();
  return (
    answer.status === "enabled" &&
    answer.runners.some((runner) => runner.desktopId === id && runner.connected)
  );
};

/**
 * Take the stand-in computer offline (its runner stops, as when the app
 * loses its network) or back online, and wait until the API sees it.
 */
export const setComputerOnline = async (
  request: APIRequestContext,
  online: boolean,
) => {
  const offlineFile = path.join(STATE_DIR, LOCAL_RUNNER_SWITCHES.offline);
  if (online) {
    rmSync(offlineFile, { force: true });
  } else {
    writeFileSync(offlineFile, "");
  }
  await expect
    .poll(async () => await isConnected(request), {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    })
    .toBe(online);
};

/**
 * Link the stand-in computer again with a new device key, as signing in to
 * the desktop app again does, and wait until it is connected on the new key.
 */
export const relinkComputer = async (request: APIRequestContext) => {
  const relinkFile = path.join(STATE_DIR, LOCAL_RUNNER_SWITCHES.relink);
  writeFileSync(relinkFile, "");
  await expect
    .poll(() => existsSync(relinkFile), {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    })
    .toBe(false);
  await expect
    .poll(async () => await isConnected(request), {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    })
    .toBe(true);
};

const logEntrySchema = v.looseObject({});
type LogEntry = v.InferOutput<typeof logEntrySchema>;

/**
 * What the agent's stand-in CLI logged (every message it received, and what
 * it did on disk) from the moment this was called on: each launch appends
 * to the same file.
 */
export const agentLog = (agent: Agent) => {
  const file = path.join(STATE_DIR, AGENTS[agent].log);
  const read = () => (existsSync(file) ? readFileSync(file, "utf-8") : "");
  const start = read().length;
  return {
    entries: (): LogEntry[] =>
      read()
        .slice(start)
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => v.parse(logEntrySchema, JSON.parse(line))),
  };
};

const wroteSchema = v.object({ wrote: v.string() });

/** The files the agent wrote on the computer since `log` started. */
export const filesWritten = (log: ReturnType<typeof agentLog>) =>
  log.entries().flatMap((entry) => {
    const parsed = v.safeParse(wroteSchema, entry);
    return parsed.success ? [parsed.output.wrote] : [];
  });

/** The messages the agent received since `log` started, as JSON text. */
export const messagesReceived = (log: ReturnType<typeof agentLog>) =>
  log
    .entries()
    .flatMap((entry) =>
      entry["received"] === undefined
        ? []
        : [JSON.stringify(entry["received"])],
    );

// ── The chat page ──────────────────────────────────────────────────────

export const composer = (page: Page) =>
  page.getByRole("textbox", { name: /type your question/iu });

export const transcript = (page: Page) => page.getByRole("log");

/** Open a new chat and wait for its composer. */
export const openNewChat = async (page: Page) => {
  await page.goto("/chat", { waitUntil: "commit" });
  // The first visit compiles the chat route on the dev server.
  await expect(composer(page)).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_60_SECONDS_MS,
  });
};

/**
 * The composer's control that names where the chat runs: "Auto" (or a
 * stella model) on stella, "<agent> · <model>" on the computer, with the
 * computer's state when it cannot take a turn.
 */
export const runOnButton = (page: Page) =>
  page.getByRole("button", {
    name: /^(?:Auto|Codex · |Claude Code · )/u,
  });

/**
 * Open the Run on menu. A click that lands while the menu that just closed
 * is still leaving can close it again, so it is opened until its first
 * choice shows.
 */
const openRunOnMenu = async (page: Page) => {
  const cloud = page.getByRole("menuitemradio", { name: "stella cloud" });
  await expect(async () => {
    if (!(await cloud.isVisible())) {
      await runOnButton(page).click();
    }
    await expect(cloud).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
};

/**
 * Close the Run on menu and its submenu. Choosing a radio item keeps a menu
 * open, as it does for the member, so each Escape closes one level.
 */
const closeMenus = async (page: Page) => {
  const menus = page.getByRole("menu");
  await expect(async () => {
    if ((await menus.count()) > 0) {
      await page.keyboard.press("Escape");
    }
    await expect(menus).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
};

/** Choose where the chat runs: on stella, or an agent and model on the computer. */
export const chooseRunOn = async (page: Page, runOn: RunOn) => {
  await openRunOnMenu(page);
  if (runOn.place === "cloud") {
    await page.getByRole("menuitemradio", { name: "stella cloud" }).click();
    await closeMenus(page);
    return;
  }
  const agent = AGENTS[runOn.agent].name;
  await page
    .getByRole("menuitem", { name: `${agent} on this computer` })
    .click();
  await page
    .getByRole("menuitemradio", { name: runOn.model, exact: true })
    .click();
  await closeMenus(page);
  await expect(runOnButton(page)).toHaveAccessibleName(
    `${agent} · ${runOn.model}`,
  );
};

export const PERMISSIONS = {
  ask: "Ask",
  auto: "Auto",
  fullAuto: "Full auto",
} as const;

/** The permission choices of a computer run, in the open Run on menu. */
const permissionItem = (page: Page, mode: keyof typeof PERMISSIONS) =>
  page.getByRole("menuitemradio", {
    name: new RegExp(`^(?:Selected\\s*)?${PERMISSIONS[mode]}\\b`, "u"),
  });

/** Choose how freely the agent may act on the computer. */
export const choosePermission = async (
  page: Page,
  mode: keyof typeof PERMISSIONS,
) => {
  await openRunOnMenu(page);
  await permissionItem(page, mode).click();
  await closeMenus(page);
};

/**
 * The most permissive mode the computer offers: Claude Code runs in full
 * auto only where its sandbox exists (macOS), Auto elsewhere.
 */
export const widestPermission = async (
  page: Page,
): Promise<"fullAuto" | "auto"> => {
  await openRunOnMenu(page);
  await expect(permissionItem(page, "auto")).toBeVisible();
  const fullAuto = permissionItem(page, "fullAuto");
  const offered =
    (await fullAuto.count()) > 0 &&
    (await fullAuto.getAttribute("aria-disabled")) !== "true";
  await closeMenus(page);
  return offered ? "fullAuto" : "auto";
};

/** The permission the open Run on menu shows as chosen. */
export const chosenPermission = async (page: Page) => {
  await openRunOnMenu(page);
  await expect(permissionItem(page, "ask")).toBeVisible();
  const chosen: string[] = [];
  for (const mode of ["ask", "auto", "fullAuto"] as const) {
    // await-in-loop: three menu items, read in order.
    if (
      (await permissionItem(page, mode).getAttribute("aria-checked")) === "true"
    ) {
      chosen.push(mode);
    }
  }
  await closeMenus(page);
  return chosen;
};

export const send = async (page: Page, text: string) => {
  // The composer's toolbar sits over the editor's middle, so focus it
  // rather than click it.
  await composer(page).focus();
  await composer(page).pressSequentially(text);
  await page.getByRole("button", { name: "Send message" }).click();
};

/** More collapsed parts than one answer has: a toggle that stays collapsed. */
const MAX_EXPANDED = 50;

/**
 * Open every collapsed part of the transcript (an answer's steps, then each
 * step's details) and return how many opened.
 */
export const expandTranscript = async (page: Page) => {
  const collapsed = transcript(page).locator('button[aria-expanded="false"]');
  let opened = 0;
  // Opening a group reveals the rows inside it, so read again after each.
  // await-in-loop: each click changes what is collapsed.
  while ((await collapsed.count()) > 0 && opened < MAX_EXPANDED) {
    await collapsed.first().click();
    opened += 1;
  }
  return opened;
};

export const stopButton = (page: Page) =>
  page.getByRole("button", { name: "Stop", exact: true });
