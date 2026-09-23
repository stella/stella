/**
 * Operator view of per-decision raw storage, and the one pass that deletes
 * objects of the older, source-wide layout.
 *
 *   # what moving decisions into their own prefixes would do, writing nothing
 *   bun run src/scripts/case-law-raw-layout.ts rows [--source <id>] [--after <decision id>]
 *
 *   # move them (the scheduler does the same, page by page)
 *   bun run src/scripts/case-law-raw-layout.ts rows --apply [--source <id>]
 *
 *   # prove nothing live names a source's older objects, and count them
 *   bun run src/scripts/case-law-raw-layout.ts sweep-legacy --source <id>
 *
 *   # then delete them
 *   bun run src/scripts/case-law-raw-layout.ts sweep-legacy --source <id> --apply
 *
 * `rows` reports without writing unless `--apply`, and lists every decision
 * it could not move or check. Every write it makes is created only if absent
 * and every pointer moves by compare-and-set, so a run repeated from any
 * point converges.
 *
 * `sweep-legacy` refuses unless no live decision of the source points outside
 * its own prefix and every live payload of the source, read back, names only
 * files in its own prefix. Run it only once no running writer still stores
 * the older layout. Erasures of the source's decisions stay pending until it
 * has run.
 */
import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import {
  RAW_LAYOUT_MODE,
  reconcileCaseLawRawLayoutPage,
} from "@/api/lib/legal-search/case-law-raw-layout";
import {
  LEGACY_RAW_SWEEP_MODE,
  sweepCaseLawLegacyRawSource,
} from "@/api/lib/legal-search/case-law-raw-legacy";
import { refreshS3 } from "@/api/lib/s3";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
} from "@/api/lib/safe-id-boundaries";
import {
  flagInteger,
  flagUuid,
  readApplyFlag,
  rejectUnknownFlags,
} from "@/api/scripts/repair-flags";

const USAGE = `Usage: bun run src/scripts/case-law-raw-layout.ts <rows|sweep-legacy> [options]

  rows              Move decisions into their own raw prefix; report only
                    unless --apply.
  sweep-legacy      Delete a source's objects of the older layout once a
                    census proves nothing live names them; count only unless
                    --apply. Requires --source.
  --source <id>     Restrict to one source.
  --after <id>      Resume the rows walk after this decision id.
  --page <n>        Decisions one page reads (default 500).
  --apply           Write. Omitted, the run only reports.
  --dry-run         Report only, the default.`;

rejectUnknownFlags({ known: ["source", "after", "page"], usage: USAGE });
const command = process.argv[2];
if (command !== "rows" && command !== "sweep-legacy") {
  console.error(USAGE);
  process.exit(1);
}
const apply = readApplyFlag(USAGE);
const sourceArg = flagUuid({ name: "source", usage: USAGE });
const afterArg = flagUuid({ name: "after", usage: USAGE });
const pageLimit = flagInteger({ fallback: 500, name: "page", usage: USAGE });

const { ingestionDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();
await refreshS3();

const sourceId =
  sourceArg === undefined
    ? undefined
    : brandPersistedCaseLawSourceId(sourceArg);

if (command === "rows") {
  const totals = new Map<string, number>();
  const walk = async (
    cursor: SafeId<"caseLawDecision"> | null,
  ): Promise<SafeId<"caseLawDecision"> | null> => {
    const page = await reconcileCaseLawRawLayoutPage({
      scopedDb: ingestionDb,
      cursor,
      limit: pageLimit,
      mode: apply ? RAW_LAYOUT_MODE.APPLY : RAW_LAYOUT_MODE.PLAN,
      ...(sourceId === undefined ? {} : { sourceId }),
      signal: new AbortController().signal,
    });
    for (const [outcome, count] of Object.entries(page.counts)) {
      totals.set(outcome, (totals.get(outcome) ?? 0) + count);
    }
    for (const { decisionId, outcome } of page.reported) {
      console.log(`${outcome}\t${decisionId}`);
    }
    return page.resumeAfter === null ? null : await walk(page.resumeAfter);
  };
  await walk(
    afterArg === undefined ? null : brandPersistedCaseLawDecisionId(afterArg),
  );
  console.log(
    `${apply ? "Applied" : "Would apply"}: ${[...totals.entries()]
      .map(([outcome, count]) => `${outcome}=${String(count)}`)
      .join(" ")}`,
  );
  // A decision that failed is listed above and is tried again by a rerun.
  process.exit((totals.get("retry") ?? 0) === 0 ? 0 : 1);
}

if (sourceId === undefined) {
  console.error("sweep-legacy needs --source.");
  console.error(USAGE);
  process.exit(1);
}
const result = await sweepCaseLawLegacyRawSource({
  scopedDb: ingestionDb,
  sourceId,
  mode: apply ? LEGACY_RAW_SWEEP_MODE.APPLY : LEGACY_RAW_SWEEP_MODE.PLAN,
  signal: new AbortController().signal,
  pageLimit,
});
const exitCode = ((): number => {
  switch (result.type) {
    case "refused":
      console.error(
        result.reason === "pointer"
          ? "Refused: a live decision of this source still points outside its own raw prefix. Run `rows --apply` first."
          : `Refused: a live payload of this source names, or may name, a file outside its own prefix (${JSON.stringify(result.census)}).`,
      );
      return 1;
    case "swept":
      console.log(
        `${result.mode === LEGACY_RAW_SWEEP_MODE.APPLY ? "Deleted" : "Would delete"} ${String(result.legacyObjects)} objects of the older layout; census ${JSON.stringify(result.census)}.`,
      );
      if (result.referencedAfter) {
        console.error(
          "A live decision pointed into the older layout while this ran, so a writer of that layout is still running. Stop it, then run `rows --apply`.",
        );
        return 1;
      }
      return 0;
    default:
      result satisfies never;
      return panic(`Unhandled legacy sweep result: ${String(result)}`);
  }
})();
process.exit(exitCode);
