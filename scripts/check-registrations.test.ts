import { panic } from "better-result";
import { expect, test } from "bun:test";
import path from "node:path";

import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import packageJson from "../package.json" with { type: "json" };
import {
  REGISTRATION_CHECKS,
  registrationCommand,
} from "./check-registrations";
import { readCheckPool } from "./ci-check-pool-registry";
import { GENERATORS } from "./generated-files";

const root = path.resolve(import.meta.dir, "..");

test("registration checks remain connected to the commands and tests CI runs", () => {
  const apiTests = new Set(listApiTestPaths(path.join(root, "apps/api")));
  for (const check of REGISTRATION_CHECKS) {
    switch (check.type) {
      case "pool": {
        const owner = readCheckPool(check.job).find(
          ({ name }) => name === check.name,
        );
        expect(owner, `${check.job}/${check.name}`).toBeDefined();
        // CI supplies its comparison ref through the environment.
        const run = owner?.run.replaceAll('"$RATCHET_BASE_REF"', "origin/main");
        expect(run).toContain(check.command.join(" "));
        break;
      }
      case "generator": {
        const guard = readCheckPool("ci-checks-rest").find(
          ({ name }) => name === "Generated files manifest guard",
        );
        expect(guard?.run).toContain(
          "bun scripts/generated-files-guard.ts --guard-b",
        );
        const generator = GENERATORS.find(({ id }) => id === check.id);
        expect(generator?.check).toEqual([...check.command]);
        break;
      }
      case "api-test": {
        expect(check.file.startsWith("./")).toBe(true);
        expect(apiTests.has(check.file.slice(2)), check.file).toBe(true);
        expect(registrationCommand(check).command).toContain(
          "./src/tests/setup-env.ts",
        );
        break;
      }
      default: {
        check satisfies never;
        panic("Unhandled registration check");
      }
    }
  }
  expect(packageJson.scripts["check:registrations"]).toBe(
    "bun scripts/check-registrations.ts",
  );
});
