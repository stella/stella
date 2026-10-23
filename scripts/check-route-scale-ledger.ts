import path from "node:path";

import { routeScaleLedgerMembership } from "../apps/web/e2e/helpers/route-scale";
import { runLedgerMembershipGuard } from "./ledger-membership";

export const checkRouteScaleLedger = (): number =>
  runLedgerMembershipGuard({
    ledgerRel: "apps/web/e2e/route-scale-ledger.json",
    repoRoot: path.resolve(import.meta.dir, ".."),
    parseLedger: routeScaleLedgerMembership,
    label: "route-scale",
    remediation: "keep route cost independent of matter cardinality",
  });

if (import.meta.main) {
  process.exitCode = checkRouteScaleLedger();
}
