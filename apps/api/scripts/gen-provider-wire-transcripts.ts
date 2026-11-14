// Records the outbound side of the two-way provider transcripts
// (src/tests/fixtures/provider-wire-transcripts): every scenario of the
// transcript suite runs through the real send pipeline against the provider
// wire corpus, and each request the pipeline makes is written, normalized,
// as the request its transcript expects. Nothing reaches a provider: the
// answers are the corpus cassettes. Review the diff before committing.
//
//   bun run gen:provider-wire-transcripts
//
// The suite then replays the committed transcripts strictly, so CI fails on
// a stale transcript without running this script. A recording replaces every
// transcript, so one whose scenario no longer exists is removed.

import { rmSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";

const API_ROOT = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const SUITE = "src/handlers/chat/provider-wire-transcripts.integration.test.ts";
/** `TRANSCRIPTS_WRITE_ENV` and `PROVIDER_WIRE_TRANSCRIPT_DIR` of
 *  `provider-wire-transcript.ts`. */
const TRANSCRIPTS_WRITE_ENV = "PROVIDER_WIRE_TRANSCRIPTS_WRITE";
const PROVIDER_WIRE_TRANSCRIPT_DIR = path.join(
  API_ROOT,
  "src/tests/fixtures/provider-wire-transcripts",
);

rmSync(PROVIDER_WIRE_TRANSCRIPT_DIR, { force: true, recursive: true });
const recording = Bun.spawn(["bun", "run", "test", SUITE], {
  cwd: API_ROOT,
  env: { ...process.env, [TRANSCRIPTS_WRITE_ENV]: "1" },
  stderr: "inherit",
  stdout: "inherit",
});
await recording.exited;
const recorded = childExitStatus(recording);
if (recorded !== 0) {
  process.exit(recorded);
}
const formatting = Bun.spawn(["bun", "fmt", PROVIDER_WIRE_TRANSCRIPT_DIR], {
  cwd: REPO_ROOT,
  stderr: "inherit",
  stdout: "inherit",
});
await formatting.exited;
process.exit(childExitStatus(formatting));
