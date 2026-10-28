/**
 * Which coding-agent harness drives a run, in the cloud sandbox or on a
 * connected desktop. The agent engine and the desktop runner protocol both
 * read this list, so a harness id means the same thing on every side.
 */
export const AGENT_HARNESSES = ["codex", "claude-code", "opencode"] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];
