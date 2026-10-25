import { planAutofix } from "./autofix-push-scope";
import {
  allowedOutputs,
  GENERATORS,
  orderGenerators,
  runGenerators,
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
    // --since names a file listing paths changed since the settled commit.
    const sinceAt = args.indexOf("--since");
    const sincePath = sinceAt === -1 ? undefined : args[sinceAt + 1];
    if (sinceAt !== -1 && !sincePath) {
      fail("--since needs a file of changed paths");
    }
    const plan = planAutofix({
      pullRequestFiles: files,
      pushFiles: sincePath
        ? (await Bun.file(sincePath).text()).split("\n").filter(Boolean)
        : null,
      all: args.includes("--all"),
    });
    const selected = plan.generators;
    console.log(`run=${selected.length > 0}`);
    console.log(`ids=${selected.map((generator) => generator.id).join(",")}`);
    console.log(`allowed=${allowedOutputs(selected).join("|")}`);
    console.log(`refix=${plan.refix}`);
    console.log(`prune=${plan.prune}`);
    console.log(`needed=${plan.needed}`);
    break;
  }
  case "run": {
    const selected = selectedFromIds(args.at(0) ?? "");
    const failed = runGenerators(
      selected,
      (command) =>
        Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" })
          .exitCode,
    );
    if (failed !== null) {
      fail(`Generator ${failed.id} failed`);
    }
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
      "Usage: bun scripts/autofix-plan.ts plan [--all] | run <ids> | allowed <ids>",
    );
}
