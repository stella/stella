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

const optionValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv.at(index + 1);
};

const main = (): number => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  if (process.argv.includes("--seed")) {
    return runSeed();
  }
  if (process.argv.includes("--check")) {
    return runCheck(readExpiryCheckScope(), optionValue("--ledger"));
  }
  return runReport();
};

if (import.meta.main) {
  process.exit(main());
}
