// Passive regression fixture for
// `require-workspace-handler-config/require-workspace-handler-config`.
//
// Each `oxlint-disable-next-line` below suppresses a case the rule MUST flag.
// If the rule regresses (the scope walk stops resolving the config binding,
// the inline form stops being read), the matching disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.

type HandlerConfig = { permissions: Record<string, string[]> };
type WorkspaceHandlerConfig = HandlerConfig;

declare const createSafeHandler: <T>(config: T, handler: () => void) => T;
declare const createSafeRootHandler: <T>(config: T, handler: () => void) => T;

const handler = () => undefined;

// A config declared separately and passed by name.
// oxlint-disable-next-line require-workspace-handler-config/require-workspace-handler-config
const namedConfig = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

export const named = createSafeHandler(namedConfig, handler);

// The inline form, where the annotation sits on the argument.
export const inline = createSafeHandler(
  // oxlint-disable-next-line require-workspace-handler-config/require-workspace-handler-config
  { permissions: { workspace: ["read"] } } satisfies HandlerConfig,
  handler,
);

// --- Cases the rule MUST NOT flag ---

// The required spelling for a workspace-scoped route.
const workspaceConfig = {
  permissions: { workspace: ["read"] },
} satisfies WorkspaceHandlerConfig;

export const workspace = createSafeHandler(workspaceConfig, handler);

// A root route keeps the wider config type: it is mounted outside any
// `:workspaceId` prefix and has no workspace segment to declare.
const rootConfig = {
  permissions: { organization: ["read"] },
} satisfies HandlerConfig;

export const root = createSafeRootHandler(rootConfig, handler);
