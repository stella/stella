import { panic } from "better-result";

// Relative imports: this module ships with the loose migrate entrypoint.
import { parseOnlineRepairRehearsalArguments } from "./online-migration-rehearsal-guard";
import { ONLINE_SCOPE } from "./online-step-lifecycle";
import type { OnlineScope } from "./online-step-lifecycle";

const ONLINE_FLAG = "--online=";
const USAGE =
  "Usage: migrate.ts [--online=all|finalized] [--rehearsal-online-repair-report <path>]";

/** The migrate scopes; the pending scope belongs to the API's runner alone. */
const MIGRATE_SCOPES: readonly OnlineScope[] = [
  ONLINE_SCOPE.all,
  ONLINE_SCOPE.finalized,
];

export type MigrateArguments = {
  /** Where the rehearsal writes its repair report, when it asks for one. */
  reportPath: string | null;
  onlineScope: OnlineScope;
};

export const parseMigrateArguments = (
  args: readonly string[],
): MigrateArguments => {
  const scopes = args.filter((arg) => arg.startsWith(ONLINE_FLAG));
  if (scopes.length > 1) {
    return panic(USAGE);
  }
  const requested = scopes.at(0)?.slice(ONLINE_FLAG.length) ?? ONLINE_SCOPE.all;
  const value =
    MIGRATE_SCOPES.find((scope) => scope === requested) ?? panic(USAGE);
  const reportPath = parseOnlineRepairRehearsalArguments(
    args.filter((arg) => !arg.startsWith(ONLINE_FLAG)),
  );
  // The rehearsal proves every registered repair ran; a scoped run cannot.
  if (reportPath !== null && value !== ONLINE_SCOPE.all) {
    return panic("The online repair rehearsal report requires --online=all");
  }
  return { reportPath, onlineScope: value };
};
