import { panic } from "better-result";

import { printError } from "@stll/errors";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { resolveDatabaseUrl } from "../db-url";
import { createOnlineIndexHold } from "../db/online-index-gate";
import {
  openOnlineIndexObserver,
  openOnlineRepairConnection,
} from "../db/online-index-observer";
import {
  ONLINE_MIGRATION_REPAIRS,
  runNextPendingOnlineUnit,
} from "../db/online-migrations";
import { drainPendingOnlineUnits } from "../db/pending-online-drain";
import { envDbLoadGate } from "../env-db-load-gate";
import {
  requireEbsConfiguration,
  resolveEbsConfiguration,
} from "../lib/db/ebs-signal-reader";

// Builds every pending online entry a `migrate --online=finalized` run left,
// one unit per session, through the same health gate as the deploy.
if (process.argv.length > 2) {
  panic("Usage: db:drain-pending-online");
}
const ebs = requireEbsConfiguration(resolveEbsConfiguration(envDbLoadGate));
if (ebs.isErr()) {
  printError("[drain-pending-online] failed:", ebs.error);
  process.exit(1);
}
const url = resolveDatabaseUrl();
if (!url) {
  panic("Draining pending online units requires a database connection");
}

await runScriptWithErrorOutput(async () => {
  const hold = createOnlineIndexHold();
  const units = await drainPendingOnlineUnits({
    runUnit: async () =>
      await runNextPendingOnlineUnit(
        { reserve: async () => await openOnlineRepairConnection(url) },
        {
          indexGate: { ebs: ebs.value, hold },
          reserveObserver: async () => await openOnlineIndexObserver(url),
          repairs: ONLINE_MIGRATION_REPAIRS,
        },
      ),
    sleep: Bun.sleep,
    emit: (outcome) => {
      process.stdout.write(
        `${JSON.stringify({ event: "online.pending_unit", ...outcome })}\n`,
      );
    },
  });
  process.stdout.write(
    `${JSON.stringify({ event: "online.pending_drained", units })}\n`,
  );
});
