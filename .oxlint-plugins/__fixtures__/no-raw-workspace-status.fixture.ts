// Passive regression fixture for `no-raw-workspace-status/no-raw-workspace-status`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

declare const workspace: { status: string };
declare const workspaces: { status: unknown };
declare const ne: (column: unknown, value: unknown) => unknown;
declare const WORKSPACE_STATUS: { readonly deleting: "deleting" };

// --- Flagged: workspace status against a literal ---
// oxlint-disable-next-line no-raw-workspace-status/no-raw-workspace-status
export const _a = workspace.status === "archived";
// oxlint-disable-next-line no-raw-workspace-status/no-raw-workspace-status
export const _b = ne(workspaces.status, "deleting");

// --- Allowed: the domain's constants ---
// expect-clean: no-raw-workspace-status/no-raw-workspace-status
export const _c = ne(workspaces.status, WORKSPACE_STATUS.deleting);
