import type { AgentHarness } from "@stll/api-contract/agent-harness";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

/**
 * The approval modes an ACP agent can run in. Full auto is not one: without
 * an OS sandbox an agent's commands are only as bounded as the permission
 * requests it chooses to send.
 */
export type AcpApprovalMode = Exclude<DesktopRunnerApprovalMode, "full_auto">;

/** What a definition's environment is built from, per process. */
type AcpLaunchContext = {
  /**
   * The stella-owned directory the agent keeps its state in, so the
   * member's own configuration is never read or written.
   */
  configDir: string;
  /** The agent's executable, absolute. */
  executable: string;
  platform: NodeJS.Platform;
};

/**
 * How stella knows the agent is signed in without asking it, for an agent
 * whose sign-in lives in a file in its state directory. Such an agent is
 * asked to `authenticate` with `methodId` before each session; it reads its
 * stored sign-in then and never starts a sign-in of its own.
 */
type AcpStoredSignIn = {
  methodId: string;
  /** Whether the agent's stored sign-in is there. */
  signedIn: (configDir: string) => boolean;
};

/**
 * What stella knows about one agent it runs over the Agent Client Protocol:
 * how to launch it and what it needs beyond the protocol. The adapter is the
 * same for every agent; a definition holds only the differences, so a new
 * ACP agent is a definition, a harness id and a version pin.
 */
export type AcpAgentDefinition = {
  readonly harness: AgentHarness;
  /** The agent's name in stella's own messages ("Antigravity"). */
  readonly displayName: string;
  /** Arguments after the executable that start the agent's ACP server. */
  readonly args: (platform: NodeJS.Platform) => readonly string[];
  /** Variables set for every process, over the inherited environment. */
  readonly environment: (
    context: AcpLaunchContext,
  ) => Readonly<Record<string, string>>;
  /** Inherited variables the agent must not see (credentials of its own). */
  readonly removedEnvironment: readonly string[];
  /** The approval modes stella runs the agent in. */
  readonly approvalModes: readonly AcpApprovalMode[];
  /**
   * The agent's session mode for each approval mode it runs in, set with
   * `session/set_mode` when the agent offers it; absent keeps its default.
   */
  readonly sessionModes: Readonly<Partial<Record<AcpApprovalMode, string>>>;
  /** `null`: the agent says itself, on `session/new`, when it is signed out. */
  readonly storedSignIn: AcpStoredSignIn | null;
  /**
   * Give each process a temporary directory of its own under the state
   * directory, removed once the process exits: for an agent that unpacks
   * itself there on every launch and leaves it behind when it is stopped.
   */
  readonly ownTempDir: boolean;
  /**
   * How long a probe's answer stands while the agent's executable and
   * stored sign-in are unchanged; 0 probes the agent every time. For an
   * agent whose every launch is slow, so the regular probe does not keep
   * relaunching it.
   */
  readonly probeCacheMs: number;
  /**
   * Whether this version of the agent takes a prompt sent while one runs
   * into the running turn (steering) instead of queueing it.
   */
  readonly steers: (version: string) => boolean;
  /**
   * Whether a failed prompt's error means the agent's saved session can no
   * longer be continued; the chat's next turn then starts a new session
   * from the transcript instead of resuming it.
   */
  readonly brokenSession: (message: string) => boolean;
  /**
   * Remove what the agent saved of a session stella opened only to read
   * the agent's models; `null` when it keeps nothing worth removing.
   */
  readonly discardSession:
    ((configDir: string, sessionId: string) => void) | null;
};
