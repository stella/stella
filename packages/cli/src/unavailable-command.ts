import { panic } from "better-result";

import type { EffectiveGrants } from "./auth/command-scopes.js";
import { scopePreflightFailure } from "./auth/command-scopes.js";
import type { CallerFeatureAccess } from "./feature-command-projection.js";
import { EXIT_CODES } from "./mcp-constants.js";
import type { CurrentRegistry } from "./registry-refresh.js";
import type { RouteNode } from "./route-types.js";

export type CommandUnavailableCause =
  | { type: "missing-scope"; scope: string; loginCommand: string }
  | { type: "feature-disabled"; command: string; feature?: string }
  | { type: "protocol-incompatible"; message: string }
  | { type: "unknown-to-server"; command: string };

/** Reasons remain distinct: a missing grant never implies a disabled feature. */
export const commandUnavailableMessage = (
  cause: CommandUnavailableCause,
): string => {
  switch (cause.type) {
    case "missing-scope":
      return `Missing scope ${cause.scope}. Re-run '${cause.loginCommand}' to grant the complete scope set.`;
    case "feature-disabled":
      return `Command '${cause.command}' is not enabled for this organization${cause.feature === undefined ? "" : ` (feature: ${cause.feature})`}.`;
    case "protocol-incompatible":
      return `Server protocol is incompatible. ${cause.message}`;
    case "unknown-to-server":
      return `Command '${cause.command}' is unknown to this server.`;
    default:
      cause satisfies never;
      return panic("Unexpected command unavailability cause");
  }
};

export const commandUnavailableExitCode = (
  cause: CommandUnavailableCause,
): number => {
  switch (cause.type) {
    case "missing-scope":
      return EXIT_CODES.auth;
    case "feature-disabled":
      return EXIT_CODES.featureDisabled;
    case "protocol-incompatible":
    case "unknown-to-server":
      return EXIT_CODES.server;
    default:
      cause satisfies never;
      return panic("Unexpected command unavailability cause");
  }
};

type ResolveCommandUnavailableCauseOptions = {
  argv: readonly string[];
  baked: RouteNode;
  current: RouteNode;
  effectiveGrants: EffectiveGrants;
  featureAccess?: CallerFeatureAccess | undefined;
  serverUrl?: string | undefined;
  evidence?:
    | Pick<
        CurrentRegistry,
        "featureOmittedTools" | "featureOmittedCapabilities"
      >
    | undefined;
};

/** Prefer explicit server omission evidence; scope grants work for opaque tokens too. */
export const resolveCommandUnavailableCause = ({
  argv,
  baked,
  current,
  effectiveGrants,
  serverUrl,
  evidence,
  featureAccess,
}: ResolveCommandUnavailableCauseOptions):
  CommandUnavailableCause | undefined => {
  let known: RouteNode = baked;
  let visible: RouteNode | undefined = current;
  let skipServerValue = false;
  for (const arg of argv) {
    if (skipServerValue) {
      skipServerValue = false;
      continue;
    }
    if (arg === "--server") {
      skipServerValue = true;
      continue;
    }
    if (arg.startsWith("--server=")) {
      continue;
    }
    if (arg.startsWith("-") || known.kind !== "route") {
      return undefined;
    }
    const child = Object.hasOwn(known.children, arg)
      ? known.children[arg]
      : undefined;
    if (child === undefined) {
      return undefined;
    }
    known = child;
    visible =
      visible?.kind === "route" && Object.hasOwn(visible.children, arg)
        ? visible.children[arg]
        : undefined;
    switch (known.kind) {
      case "route":
        continue;
      case "leaf":
      case "capability-leaf": {
        return boundCommandUnavailableCause({
          known,
          current: visible,
          effectiveGrants,
          serverUrl,
          evidence,
          featureAccess,
        });
      }
      default:
        known satisfies never;
        return panic("Unexpected command node");
    }
  }
  return undefined;
};

type BoundCommandUnavailableCauseOptions = Pick<
  ResolveCommandUnavailableCauseOptions,
  "effectiveGrants" | "serverUrl" | "evidence" | "featureAccess"
> & {
  known: Exclude<RouteNode, { kind: "route" }>;
  current: RouteNode | undefined;
};

/** Attribute a resolved binding only to attested feature denials or known missing grants. */
const boundCommandUnavailableCause = ({
  known,
  current,
  effectiveGrants,
  serverUrl,
  evidence,
  featureAccess,
}: BoundCommandUnavailableCauseOptions):
  CommandUnavailableCause | undefined => {
  const omittedForFeature =
    known.kind === "leaf"
      ? evidence?.featureOmittedTools?.includes(known.spec.toolName) === true ||
        featureAccess?.disabled?.tools.includes(known.spec.toolName) === true
      : evidence?.featureOmittedCapabilities?.includes(
          known.spec.capabilityId,
        ) === true ||
        featureAccess?.disabled?.capabilities.includes(
          known.spec.capabilityId,
        ) === true;
  const command = known.spec.commandPath.join(" ");
  if (omittedForFeature === true) {
    const feature = known.spec.featureId ?? known.spec.feature;
    return {
      type: "feature-disabled",
      command,
      ...(feature === undefined ? {} : { feature }),
    };
  }
  const scopeFailure = scopePreflightFailure({
    scope: known.spec.scope,
    additionalScopes: known.spec.additionalScopes,
    effectiveGrants,
    serverUrl,
  });
  if (scopeFailure !== undefined) {
    return scopeFailure;
  }
  // A hidden feature-marked command alone is not proof of disabled enrolment.
  return current === undefined && evidence !== undefined
    ? { type: "unknown-to-server", command }
    : undefined;
};
