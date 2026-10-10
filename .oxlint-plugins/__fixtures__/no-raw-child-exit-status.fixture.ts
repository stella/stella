import { childExitStatus } from "../../packages/scripts/src/child-exit-status";

const child = Bun.spawn(["true"]);
// oxlint-disable-next-line no-raw-child-exit-status/no-raw-child-exit-status -- fixture proves raw child status cannot reach the exit sink
process.exit(child.exitCode);
const { exitCode } = child;
// oxlint-disable-next-line no-raw-child-exit-status/no-raw-child-exit-status -- fixture proves destructuring retains child status provenance
process.exitCode = exitCode;
// expect-clean: no-raw-child-exit-status/no-raw-child-exit-status
process.exit(childExitStatus(child));
