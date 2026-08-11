// Passive regression fixture for
// `forbid-dev-runner-config-reads/forbid-dev-runner-config-reads`.

// MUST flag: CLI parsing belongs to the pure dev-runner config boundary.
// oxlint-disable-next-line forbid-dev-runner-config-reads/forbid-dev-runner-config-reads -- fixture: raw argv reads must stay in the parser module
export const rawArguments = process.argv.slice(2);

// MUST flag: runner-specific environment parsing belongs to the same boundary.
// oxlint-disable-next-line forbid-dev-runner-config-reads/forbid-dev-runner-config-reads, typescript/dot-notation -- fixture: raw config environment reads must stay in the parser module
export const rawPortOffset = process.env["STELLA_PORT_OFFSET"];

// Allowed: unrelated ambient environment values are forwarded by the runner.
export const ambientEnvironment = process.env;
