import { panic, Result } from "better-result";
import path from "node:path";
import * as v from "valibot";

import { CHAT_LOCAL_RUN_WEB_SEARCH_BY_HARNESS } from "@stll/api-contract/chat-run-target";

import {
  type HarnessRunPolicy,
  HarnessStartError,
  type HarnessTurnInput,
} from "../adapter";
import type { HarnessContinuation } from "../events";
import {
  loadableSkillFolders,
  realPathOf,
  realSkillFile,
} from "../skill-folders";
import type { AppServerClient } from "./app-server-client";
import { SkillsListResponseSchema, ThreadResponseSchema } from "./protocol";

/**
 * Opening the Codex thread a turn runs in: a new one, or the native session
 * the caller asked to resume. Resume reads metadata only (stella holds the
 * transcript) and unarchives an archived session first. When the session
 * cannot be resumed, a new thread starts and the outcome says why, so the
 * turn falls back to the portable transcript visibly.
 */

const SANDBOX_MODE = {
  workspace: "workspace-write",
} as const satisfies Record<HarnessRunPolicy["fs"], string>;
/**
 * Whether the run's network policy lets the sandbox reach the network; a
 * level may still turn it off (`CODEX_LEVEL`).
 */
const NETWORK_ACCESS: Readonly<Record<HarnessRunPolicy["network"], boolean>> = {
  open: true,
};
/**
 * The approval modes Codex runs in, named one by one so a new mode is never
 * offered by default. Not plan: the pinned app-server has plan mode only as
 * an experimental turn parameter.
 */
export const CODEX_APPROVAL_MODES = [
  "ask",
  "auto",
  "full_auto",
] as const satisfies readonly HarnessRunPolicy["approvals"][];
type CodexApprovalMode = (typeof CODEX_APPROVAL_MODES)[number];

export const isCodexApprovalMode = (
  mode: HarnessRunPolicy["approvals"],
): mode is CodexApprovalMode =>
  CODEX_APPROVAL_MODES.some((supported) => supported === mode);

/**
 * Codex's settings per approval mode, strictly ordered: each level allows
 * everything the one below it does and more, so a ceiling at a level never
 * yields a higher level's settings. Commands always run inside the workspace
 * sandbox, and leaving it is always asked about; stella relays the question.
 * `never` is not used: it would turn those questions into silent refusals.
 *
 * Codex has no policy that applies file changes without asking while asking
 * before commands: `untrusted` asks before both, `on-request` before neither.
 * Auto keeps the command gate, so it asks before file changes too.
 * - `ask`: `untrusted`, no network in the sandbox. Asks before file changes
 *   and before any command Codex does not know to be read-only; a command
 *   that needs the network asks to leave the sandbox.
 * - `auto`: `untrusted`, network on. Asks before file changes and before any
 *   command Codex does not know to be read-only.
 * - `full_auto`: `on-request`, network on. File changes inside the workspace
 *   and commands inside the sandbox run without asking.
 */
const CODEX_LEVEL = {
  ask: { approvalPolicy: "untrusted", networkAccess: false },
  auto: { approvalPolicy: "untrusted", networkAccess: true },
  full_auto: { approvalPolicy: "on-request", networkAccess: true },
} as const satisfies Record<
  CodexApprovalMode,
  { approvalPolicy: "untrusted" | "on-request"; networkAccess: boolean }
>;
/**
 * Codex's `web_search` setting for each way its search runs: live search of
 * the web, or none. Codex cannot pause a search for approval, so the
 * contract's table never asks it to.
 */
const WEB_SEARCH_MODE = {
  unasked: "live",
  off: "disabled",
} as const satisfies Record<
  (typeof CHAT_LOCAL_RUN_WEB_SEARCH_BY_HARNESS)["codex"][HarnessRunPolicy["approvals"]],
  string
>;
/** A dotted config key carries the name, so it must stay a bare TOML key. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/u;

/** The skills Codex installs with itself; none comes from a member's files. */
const SYSTEM_SKILL_SCOPE = "system";

const ARCHIVED = /\barchived\b|\bunarchive\b/iu;
const SESSION_MISSING = /no rollout found|not found/iu;

const skillsRefused = (message: string) =>
  new HarnessStartError({ reason: "start_rejected", message });

/**
 * Gives the app server this turn's skill folders and answers every skill to
 * switch off for the thread. A run's skills are Codex's own and the `SKILL.md`
 * of each listed folder, and nothing else: Codex also loads the working
 * directory's skills, the member's own, and anything under a root, however deep
 * and through any link. The roots last as long as this process, one turn, and
 * nothing is written to the Codex home. A turn whose skills cannot be
 * established does not run.
 */
const establishSkills = async (
  client: AppServerClient,
  input: HarnessTurnInput,
): Promise<Result<readonly string[], HarnessStartError>> => {
  const folders = await loadableSkillFolders(input.skillFolders);
  if (folders.length > 0) {
    const set = await client.request("skills/extraRoots/set", {
      extraRoots: folders.map(({ path: folder }) => folder),
    });
    if (Result.isError(set)) {
      return Result.err(skillsRefused(set.error.message));
    }
  }
  const listed = await client.request("skills/list", {
    cwds: [input.workspaceDir],
    forceReload: true,
  });
  if (Result.isError(listed)) {
    return Result.err(skillsRefused(listed.error.message));
  }
  const parsed = v.safeParse(SkillsListResponseSchema, listed.value);
  if (!parsed.success) {
    return Result.err(
      skillsRefused(
        "The harness answered skills/list with an unexpected shape.",
      ),
    );
  }
  // A listing without the run's own folder named nothing it would load there,
  // so switching off what it named would leave that folder's skills on.
  const workspace = await realPathOf(input.workspaceDir);
  const listsWorkspace = await Promise.all(
    parsed.output.data.map(
      async ({ cwd }) =>
        cwd === input.workspaceDir || (await realPathOf(cwd)) === workspace,
    ),
  );
  if (!listsWorkspace.includes(true)) {
    return Result.err(
      skillsRefused("The harness listed no skills for the run's folder."),
    );
  }
  // A skill discovery could not read is in no listing, so nothing would
  // switch it off.
  if (parsed.output.data.some(({ errors }) => errors.length > 0)) {
    return Result.err(
      skillsRefused("The harness could not read every skill it found."),
    );
  }
  const allowed = new Set(
    await Promise.all(
      folders.map(async ({ path: folder }) => realSkillFile(folder)),
    ),
  );
  allowed.delete(null);
  const skills = parsed.output.data.flatMap((entry) => entry.skills);
  const kept = await Promise.all(
    skills.map(
      async ({ path: skillPath, scope }) =>
        scope === SYSTEM_SKILL_SCOPE ||
        allowed.has(await realPathOf(skillPath)),
    ),
  );
  return Result.ok([
    ...new Set(
      skills.flatMap(({ path: skillPath }, index) =>
        kept[index] === true ? [] : [skillPath],
      ),
    ),
  ]);
};

const threadParams = (
  input: HarnessTurnInput,
  disabledSkills: readonly string[],
) => {
  if (!MCP_SERVER_NAME.test(input.mcp.serverName)) {
    panic("Codex adapter: the MCP server name must be a bare TOML key");
  }
  if (!path.isAbsolute(input.cacheDir)) {
    panic("Codex adapter: the cache directory must be an absolute path");
  }
  const { approvals } = input.policy;
  // `startTurn` refuses any other mode before a thread is asked for.
  const level = isCodexApprovalMode(approvals)
    ? CODEX_LEVEL[approvals]
    : panic("Codex adapter: the turn's approval mode is not a Codex one");
  return {
    model: input.model,
    cwd: input.workspaceDir,
    approvalPolicy: level.approvalPolicy,
    sandbox: SANDBOX_MODE[input.policy.fs],
    developerInstructions: input.instructions,
    config: {
      // Codex's own web search follows the permission level: live rather
      // than from its cached index where the level runs it without asking,
      // and off where a search would need the member's approval.
      web_search:
        WEB_SEARCH_MODE[
          CHAT_LOCAL_RUN_WEB_SEARCH_BY_HARNESS.codex[input.policy.approvals]
        ],
      "sandbox_workspace_write.network_access":
        NETWORK_ACCESS[input.policy.network] && level.networkAccess,
      // Package caches live outside the workspace; the temp directory and
      // `/tmp` stay writable, as tools that make scratch files expect.
      "sandbox_workspace_write.writable_roots": [input.cacheDir],
      "sandbox_workspace_write.exclude_tmpdir_env_var": false,
      "sandbox_workspace_write.exclude_slash_tmp": false,
      ...(disabledSkills.length > 0
        ? {
            "skills.config": disabledSkills.map((skillPath) => ({
              path: skillPath,
              enabled: false,
            })),
          }
        : {}),
      // Only stella's server is overridden; others in the home survive. The
      // token travels over stdio, never on the command line.
      [`mcp_servers.${input.mcp.serverName}`]: {
        url: input.mcp.url,
        http_headers: { Authorization: `Bearer ${input.mcp.token}` },
        // The stella MCP server enforces its own approvals for writes.
        default_tools_approval_mode: "approve",
      },
    },
  };
};

const threadIdOf = (raw: unknown) => {
  const parsed = v.safeParse(ThreadResponseSchema, raw);
  return parsed.success ? parsed.output.thread.id : null;
};

type OpenedThread = {
  threadId: string;
  continuation: HarnessContinuation;
};

const startThread = async (
  client: AppServerClient,
  params: ReturnType<typeof threadParams>,
  continuation: HarnessContinuation,
): Promise<Result<OpenedThread, HarnessStartError>> => {
  const started = await client.request("thread/start", params);
  const threadId = Result.isOk(started) ? threadIdOf(started.value) : null;
  if (threadId === null) {
    return Result.err(
      new HarnessStartError({
        reason: "start_rejected",
        message: Result.isError(started)
          ? started.error.message
          : "The harness answered thread/start with an unexpected shape.",
      }),
    );
  }
  return Result.ok({ threadId, continuation });
};

export const openThread = async (
  client: AppServerClient,
  input: HarnessTurnInput,
): Promise<Result<OpenedThread, HarnessStartError>> => {
  const disabledSkills = await establishSkills(client, input);
  if (Result.isError(disabledSkills)) {
    return disabledSkills;
  }
  const params = threadParams(input, disabledSkills.value);
  if (input.continuation.type === "fresh") {
    return startThread(client, params, { type: "fresh" });
  }
  const threadId = input.continuation.sessionId;
  const resume = async () =>
    await client.request("thread/resume", {
      threadId,
      excludeTurns: true,
      ...params,
    });
  let resumed = await resume();
  if (Result.isError(resumed) && ARCHIVED.test(resumed.error.message)) {
    const unarchived = await client.request("thread/unarchive", { threadId });
    if (Result.isOk(unarchived)) {
      resumed = await resume();
    }
  }
  if (Result.isOk(resumed)) {
    const resumedId = threadIdOf(resumed.value);
    if (resumedId === null) {
      return Result.err(
        new HarnessStartError({
          reason: "protocol_violation",
          message:
            "The harness answered thread/resume with an unexpected shape.",
        }),
      );
    }
    return Result.ok({
      threadId: resumedId,
      continuation: { type: "resumed" },
    });
  }
  // Only a refusal falls back to a new session: a closed or silent harness
  // cannot start one either.
  if (resumed.error.reason !== "rejected") {
    return Result.err(
      new HarnessStartError({
        reason: "harness_unavailable",
        message: resumed.error.message,
      }),
    );
  }
  return startThread(client, params, {
    type: "resume_unavailable",
    reason: SESSION_MISSING.test(resumed.error.message)
      ? "session_not_found"
      : "resume_rejected",
    message: resumed.error.message,
  });
};
