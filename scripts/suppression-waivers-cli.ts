/**
 * Command line for the security-tier suppression ledger in
 * `suppression-waivers.ts`. The expiry scope's git reads live here so the
 * ledger module stays importable by offline checks.
 *
 * Run: `bun scripts/suppression-waivers-cli.ts [--check | --seed | --self-test]`
 */

import { readExpiryCheckScope } from "./expiry-check-scope-git";
import {
  runCheck,
  runReport,
  runSeed,
  runSelfTest,
} from "./suppression-waivers";

const main = (): number => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  if (process.argv.includes("--seed")) {
    return runSeed();
  }
  if (process.argv.includes("--check")) {
    return runCheck(readExpiryCheckScope());
  }
  return runReport();
};

if (import.meta.main) {
  process.exit(main());
}
