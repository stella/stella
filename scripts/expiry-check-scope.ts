// Runs before any dependency install (install-free-ci.test.ts), so it
// raises a tagged built-in error instead of a better-result panic.
export class ExpiryScopeError extends Error {
  override name = "ExpiryScopeError";
  readonly _tag = "ExpiryScopeError";
}

export type ExpiryCheckScope =
  | { type: "all" }
  | { type: "changes"; changedFiles: ReadonlySet<string>; baseSha?: string };

/** Only wall-clock expiry is scoped; malformed and undated entries always fail. */
export const expiryBlocksFiles = (
  scope: ExpiryCheckScope,
  owningFiles: readonly string[],
): boolean =>
  scope.type === "all" ||
  owningFiles.some((file) => scope.changedFiles.has(file));

export const expiryWarning = (message: string): string =>
  `::warning::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;

export const expiryScopeBase = (
  eventName: string,
  event: unknown,
): string | undefined => {
  if (eventName !== "pull_request" && eventName !== "merge_group") {
    return undefined;
  }
  if (typeof event !== "object" || event === null) {
    throw new ExpiryScopeError("Expiry scope requires a GitHub event payload");
  }
  let base: unknown;
  if (eventName === "pull_request" && "pull_request" in event) {
    const pr = event.pull_request;
    if (typeof pr === "object" && pr !== null && "base" in pr) {
      const prBase = pr.base;
      if (typeof prBase === "object" && prBase !== null && "sha" in prBase) {
        base = prBase.sha;
      }
    }
  }
  if (eventName === "merge_group" && "merge_group" in event) {
    const group = event.merge_group;
    if (typeof group === "object" && group !== null && "base_sha" in group) {
      base = group.base_sha;
    }
  }
  if (typeof base !== "string" || !/^[a-f\d]{40}$/u.test(base)) {
    throw new ExpiryScopeError(
      "Expiry scope requires the exact event base SHA",
    );
  }
  return base;
};
