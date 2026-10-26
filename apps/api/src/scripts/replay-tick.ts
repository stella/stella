/**
 * One bounded, load-aware background replay tick. The command lives in
 * replay-tick-command.ts, which other scripts import instead of this entry:
 * the image builds its scripts with shared chunks, and an imported entry would
 * move into one, where its `import.meta.main` block never runs.
 */

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { runReplayTickScript } from "@/api/scripts/replay-tick-command";

if (import.meta.main) {
  await runScriptWithErrorOutput(async () => {
    process.exit(await runReplayTickScript());
  });
}
