import { appendFileSync, readFileSync } from "node:fs";

import { BASELINE_PATHS } from "./baseline-paths";
import {
  GENERATORS,
  RATCHET_GENERATOR_ID,
  allowedOutputs,
  generatorsForFiles,
  orderGenerators,
} from "./generated-files";

// The explicit type lets calls narrow the values they reject.
const fail: (message: string) => never = (message) => {
  console.error(message);
  process.exit(1);
};

const [rawMode, ...args] = process.argv.slice(2);
const mode = rawMode ?? "";

const selectedFromIds = (ids: string) => {
  if (ids === "") {
    fail("Autofix plan has no selected generators");
  }
  const requested = ids.split(",");
  const selected = GENERATORS.filter((generator) =>
    requested.includes(generator.id),
  );
  if (
    selected.length !== requested.length ||
    selected.some((generator) => !generator.autofix)
  ) {
    fail("Autofix plan contains an unknown or ineligible generator");
  }
  return orderGenerators(selected);
};

switch (mode) {
  case "plan": {
    const input = await Bun.stdin.text();
    const files = input.split("\n").filter(Boolean);
    const selected = orderGenerators(
      args.includes("--all")
        ? GENERATORS.filter((generator) => generator.autofix)
        : generatorsForFiles(files),
    );
    console.log(`run=${selected.length > 0}`);
    console.log(`ids=${selected.map((generator) => generator.id).join(",")}`);
    console.log(`allowed=${allowedOutputs(selected).join("|")}`);
    console.log(
      `ratchet=${selected.some(({ id }) => id === RATCHET_GENERATOR_ID)}`,
    );
    break;
  }
  case "run": {
    const selected = selectedFromIds(args.at(0) ?? "");
    for (const generator of selected) {
      // Measure the final tree after every generator and changed-file autofix.
      if (generator.id === RATCHET_GENERATOR_ID) {
        continue;
      }
      if (generator.check) {
        const checked = Bun.spawnSync([...generator.check], {
          stdout: "inherit",
          stderr: "inherit",
        });
        if (checked.exitCode === 0) {
          continue;
        }
      }
      console.log(`Regenerating ${generator.id}`);
      const result = Bun.spawnSync([...generator.write], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if (result.exitCode !== 0) {
        fail(`Generator ${generator.id} failed`);
      }
    }
    break;
  }
  case "run-ratchet": {
    const generator = selectedFromIds(args.at(0) ?? "").find(
      ({ id }) => id === RATCHET_GENERATOR_ID,
    );
    if (generator === undefined) {
      fail("Autofix plan did not select the ratchet generator");
    }
    const base = args.at(1);
    if (base === undefined || base.startsWith("--")) {
      fail("Ratchet autofix requires the merge-base commit");
    }
    const output = process.env["GITHUB_OUTPUT"];
    if (output === undefined) {
      fail("Ratchet autofix requires GITHUB_OUTPUT");
    }
    const before = readFileSync(BASELINE_PATHS.ratchet, "utf-8");
    const result = Bun.spawnSync([...generator.write, "--base", base], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      fail("Ratchet improvement generator failed");
    }
    const written = before !== readFileSync(BASELINE_PATHS.ratchet, "utf-8");
    appendFileSync(output, `ratchet_written=${written}\n`);
    break;
  }
  case "allowed": {
    for (const output of allowedOutputs(selectedFromIds(args.at(0) ?? ""))) {
      console.log(output);
    }
    break;
  }
  default:
    fail(
      "Usage: bun scripts/autofix-plan.ts plan [--all] | run <ids> | run-ratchet <ids> <merge-base> | allowed <ids>",
    );
}
