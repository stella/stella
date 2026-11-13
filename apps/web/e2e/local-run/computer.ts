import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  LOCAL_RUNNER_LINK_FILE,
  LOCAL_RUNNER_SWITCHES,
  localRunnerDir,
} from "@stll/scripts/src/agent-local-runner-files";
import { escapeRegExp } from "@stll/text-normalize";

import { apiGet } from "../helpers/api";
import { expect } from "../helpers/test";
import {
  PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  PLAYWRIGHT_EXPECT_TIMEOUT_60_SECONDS_MS,
} from "../helpers/wait-budgets";

// The stand-in computer the suite drives (started by
// `packages/scripts/src/e2e-local-runner.ts` or `agent:up -- --local-runner`)
// and the page objects for the chat. How the composer offers where a chat
// runs is known only to the "Where the chat runs" section below.

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

// ── Where the chat runs ────────────────────────────────────────────────
//
// The composer offers it as two chips: where (the cloud, or a coding agent on
// the member's computer, with its permissions) and the model that place
// offers. Everything that knows how they are laid out is in this section.

/** A menu radio item by its name; a chosen one reads "Selected" first. */
const radioNamed = (page: Page, name: string) =>
  page.getByRole("menuitemradio", {
    name: new RegExp(`^(?:Selected\\s*)?${name}`, "u"),
  });

/** The where chip: "Runs on: Cloud", "Runs on: Your computer, Codex". */
const whereChip = (page: Page) =>
  page.getByRole("button", { name: /^Runs on: /u });

/** The model chip, named by the model it shows. */
const modelChip = (page: Page) =>
  page.locator('button[data-composer-chip="model"]');

const cloudPlace = (page: Page) => radioNamed(page, "Cloud\\b");

const agentPlace = (page: Page, agent: Agent) =>
  radioNamed(page, `${escapeRegExp(AGENTS[agent].name)}$`);

/** A model of the chosen agent; its recommended one is listed as the default. */
const modelChoice = (page: Page, model: string) =>
  radioNamed(page, `(?:Default \\(recommended\\)\\s*)?${escapeRegExp(model)}$`);

/**
 * Open a chip's menu. A click that lands while the menu that just closed is
 * still leaving can close it again, so it is opened until `shown` shows.
 */
const openChipMenu = async (chip: Locator, shown: Locator) => {
  await expect(async () => {
    if (!(await shown.isVisible())) {
      await chip.click();
    }
    await expect(shown).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
};

const openWhereMenu = async (page: Page) => {
  await openChipMenu(whereChip(page), cloudPlace(page));
};

/** Close whatever menu is open; a pick that keeps its menu open needs it. */
const closeMenus = async (page: Page) => {
  const menus = page.getByRole("menu");
  await expect(async () => {
    if ((await menus.count()) > 0) {
      await page.keyboard.press("Escape");
    }
    await expect(menus).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
};

const WHERE_NAMES = {
  cloud: "Runs on: Cloud",
  codex: "Runs on: Your computer, Codex",
  "claude-code": "Runs on: Your computer, Claude Code",
} as const satisfies Record<"cloud" | Agent, string>;

/** The model chip's name in the cloud while no model is chosen. */
const CLOUD_MODEL = "Auto";

/**
 * The chips name `runOn` as where the chat runs, and nothing about the
 * computer's state (offline, signed out) beside it.
 */
export const expectRunOn = async (page: Page, runOn: RunOn) => {
  await expect(whereChip(page)).toHaveAccessibleName(
    WHERE_NAMES[runOn.place === "cloud" ? "cloud" : runOn.agent],
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );
  await expect(modelChip(page)).toHaveAccessibleName(
    runOn.place === "cloud" ? CLOUD_MODEL : runOn.model,
  );
};

/** Why the where chip says the computer cannot take a turn now. */
export const COMPUTER_STATES = {
  offline: "Computer offline",
  openingDesktop: "Opening stella desktop...",
} as const;

/** The where chip names the computer `agent` runs on as in `state`. */
export const expectComputerState = async (
  page: Page,
  agent: Agent,
  state: keyof typeof COMPUTER_STATES,
) => {
  await expect(whereChip(page)).toHaveAccessibleName(
    `${WHERE_NAMES[agent]}. ${COMPUTER_STATES[state]}`,
    { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS },
  );
};

/** Choose where the chat runs: the cloud, or an agent and model on the computer. */
export const chooseRunOn = async (page: Page, runOn: RunOn) => {
  await openWhereMenu(page);
  if (runOn.place === "cloud") {
    await cloudPlace(page).click();
    await closeMenus(page);
    await expectRunOn(page, runOn);
    return;
  }
  // Picking the agent closes the menu and sets the agent's recommended model.
  await agentPlace(page, runOn.agent).click();
  await closeMenus(page);
  await expect(whereChip(page)).toHaveAccessibleName(WHERE_NAMES[runOn.agent]);
  const model = modelChoice(page, runOn.model);
  await openChipMenu(modelChip(page), model);
  await model.click();
  await closeMenus(page);
  await expectRunOn(page, runOn);
};

/**
 * Whether the model chip offers each of `models` for the place chosen now,
 * in their order.
 */
export const modelsOffered = async (
  page: Page,
  agent: Agent,
  models: readonly string[],
) => {
  // The list is headed by its agent once the computer's models are read.
  const heading = page
    .getByRole("menu")
    .getByText(`${AGENTS[agent].name} models`, { exact: true });
  await openChipMenu(modelChip(page), heading);
  const offered: boolean[] = [];
  for (const model of models) {
    // await-in-loop: the rows of one open menu, read in order.
    offered.push((await modelChoice(page, model).count()) > 0);
  }
  await closeMenus(page);
  return offered;
};

export const PERMISSIONS = {
  plan: "Plan",
  ask: "Ask",
  auto: "Auto",
  fullAuto: "Full auto",
} as const;
type Permission = keyof typeof PERMISSIONS;

/** A permission of a computer run, in the open where menu. */
const permissionItem = (page: Page, mode: Permission) =>
  radioNamed(page, `${PERMISSIONS[mode]}\\b`);

/** Choose how freely the agent may act on the computer. */
export const choosePermission = async (page: Page, mode: Permission) => {
  await openWhereMenu(page);
  await permissionItem(page, mode).click();
  await expect(permissionItem(page, mode)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await closeMenus(page);
};

/**
 * The most permissive mode the computer offers: Claude Code runs in full
 * auto only where its sandbox exists (macOS), Auto elsewhere.
 */
export const widestPermission = async (
  page: Page,
): Promise<"fullAuto" | "auto"> => {
  await openWhereMenu(page);
  await expect(permissionItem(page, "auto")).toBeVisible();
  const fullAuto = permissionItem(page, "fullAuto");
  const offered =
    (await fullAuto.count()) > 0 &&
    (await fullAuto.getAttribute("aria-disabled")) !== "true";
  await closeMenus(page);
  return offered ? "fullAuto" : "auto";
};

/** The permissions the open where menu shows as chosen. */
export const chosenPermission = async (page: Page) => {
  await openWhereMenu(page);
  await expect(permissionItem(page, "ask")).toBeVisible();
  const chosen: Permission[] = [];
  for (const mode of ["plan", "ask", "auto", "fullAuto"] as const) {
    // await-in-loop: the menu's permission rows, read in order.
    const item = permissionItem(page, mode);
    if (
      (await item.count()) > 0 &&
      (await item.getAttribute("aria-checked")) === "true"
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
  // Disclosures only: a menu's trigger is collapsed too, and opening it
  // covers the transcript.
  const collapsed = transcript(page)
    .locator('button[aria-expanded="false"]:not([aria-haspopup])')
    .filter({ visible: true });
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
