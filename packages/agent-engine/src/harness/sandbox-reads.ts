import path from "node:path";

import { isPathInside, isPathStrictlyInside } from "@stll/portable-path";

/**
 * What a turn's sandboxed commands may read, in the terms a harness's OS
 * sandbox takes: `deny`, the paths no command reads, and `allow`, paths
 * inside them that stay readable and win over the `deny` they lie in.
 */
export type SandboxReads = {
  deny: readonly string[];
  allow: readonly string[];
};

const resolved = (entries: readonly string[]) => [
  ...new Set(entries.map((entry) => path.resolve(entry))),
];

/**
 * The reads of a turn. Everything `unreadable` names is denied. Inside it,
 * the turn's own `workspace` and the paths it `needs` are re-opened, with two
 * limits:
 *
 * - A path that is a denied one, or holds one, is left out: re-opening it
 *   would re-open everything under it.
 * - Inside the innermost denied path holding the workspace, the folder that
 *   holds every chat's folder, only the workspace is re-opened, so no other
 *   chat's folder becomes readable through a path the turn was handed.
 */
export const sandboxReads = ({
  unreadable,
  workspace,
  needed,
}: {
  unreadable: readonly string[];
  workspace: string;
  needed: readonly string[];
}): SandboxReads => {
  const deny = resolved(unreadable);
  const own = path.resolve(workspace);
  // Every denied path holding the workspace is an ancestor of it, so the
  // longest is the innermost.
  let chats: string | null = null;
  for (const denied of deny) {
    if (
      isPathStrictlyInside(denied, own) &&
      (chats === null || denied.length > chats.length)
    ) {
      chats = denied;
    }
  }
  const allow = resolved([own, ...needed]).filter(
    (entry) =>
      deny.some((denied) => isPathInside(denied, entry)) &&
      !deny.some((denied) => isPathInside(entry, denied)) &&
      (entry === own || chats === null || !isPathInside(chats, entry)),
  );
  return { deny, allow };
};
