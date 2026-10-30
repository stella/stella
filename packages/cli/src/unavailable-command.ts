import type { RouteNode } from "./route-types.js";

type UnavailableCommandErrorArgs = {
  argv: readonly string[];
  baked: RouteNode;
  current: RouteNode;
};

/** Explain a known command omitted from the caller's current command tree. */
export const unavailableCommandError = ({
  argv,
  baked,
  current,
}: UnavailableCommandErrorArgs): string | undefined => {
  let known: RouteNode | undefined = baked;
  let visible: RouteNode | undefined = current;
  const segments: string[] = [];
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
    if (arg.startsWith("-")) {
      break;
    }
    if (known.kind !== "route") {
      break;
    }
    if (!Object.hasOwn(known.children, arg)) {
      return undefined;
    }
    known = known.children[arg];
    visible =
      visible?.kind === "route" && Object.hasOwn(visible.children, arg)
        ? visible.children[arg]
        : undefined;
    segments.push(arg);
    if (known === undefined) {
      return undefined;
    }
    if (known.kind !== "route") {
      if (visible !== undefined) {
        return undefined;
      }
      const feature = known.spec.featureId ?? known.spec.feature;
      const reason = feature === undefined ? "" : ` (feature: ${feature})`;
      return `Command '${segments.join(" ")}' is not enabled for this organization${reason}. Check the organization's enabled features and your access.\n`;
    }
  }
  return undefined;
};
