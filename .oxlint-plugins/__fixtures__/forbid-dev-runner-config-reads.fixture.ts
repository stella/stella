// Passive regression fixture for
// `forbid-dev-runner-config-reads/forbid-dev-runner-config-reads`.

// MUST flag: CLI parsing belongs to the pure dev-runner config boundary.
// oxlint-disable-next-line forbid-dev-runner-config-reads/forbid-dev-runner-config-reads -- fixture: raw argv reads must stay in the parser module
export const rawArguments = process.argv.slice(2);

// MUST flag: destructuring does not create an allowed configuration boundary.
// oxlint-disable-next-line forbid-dev-runner-config-reads/forbid-dev-runner-config-reads -- fixture: destructured argv reads must stay in the parser module
const { argv: destructuredArguments } = process;

// MUST flag: runner-specific environment parsing belongs to the same boundary.
// oxlint-disable-next-line forbid-dev-runner-config-reads/forbid-dev-runner-config-reads, typescript/dot-notation -- fixture: raw config environment reads must stay in the parser module
export const rawPortOffset = process.env["STELLA_PORT_OFFSET"];

// MUST flag: every configured runner environment name stays behind the parser.
// oxlint-disable-next-line forbid-dev-runner-config-reads/forbid-dev-runner-config-reads, typescript/dot-notation -- fixture: raw config environment reads must stay in the parser module
export const rawInfraOffset = process.env["STELLA_INFRA_OFFSET"];

// oxlint-disable-next-line forbid-dev-runner-config-reads/forbid-dev-runner-config-reads, typescript/dot-notation -- fixture: raw config environment reads must stay in the parser module
export const rawDevInstance = process.env["STELLA_DEV_INSTANCE"];

// MUST flag: destructured runner-specific environment values are also reads.
// oxlint-disable-next-line forbid-dev-runner-config-reads/forbid-dev-runner-config-reads -- fixture: destructured config environment reads must stay in the parser module
const { STELLA_PORT_OFFSET: destructuredPortOffset } = process.env;

// Allowed: unrelated ambient environment values are forwarded by the runner.
export const ambientEnvironment = process.env;

void destructuredArguments;
void destructuredPortOffset;
