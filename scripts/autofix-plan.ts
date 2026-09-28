import {
  GENERATORS,
  generatorsForFiles,
  orderGenerators,
} from "./generated-files";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const [mode, ...args] = process.argv.slice(2);

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
    break;
  }
  case "run": {
    const selected = selectedFromIds(args.at(0) ?? "");
    for (const generator of selected) {
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
  case "allowed": {
    for (const output of new Set(
      selectedFromIds(args.at(0) ?? "").flatMap(
        (generator) => generator.outputs,
      ),
    )) {
      console.log(output);
    }
    break;
  }
  default:
    fail(
      "Usage: bun scripts/autofix-plan.ts plan [--all] | run <ids> | allowed <ids>",
    );
}
