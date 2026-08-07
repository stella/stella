import { buildCommand, buildRouteMap } from "@stricli/core";
import type { RouteMap } from "@stricli/core";
import { Result } from "better-result";

import { checkServerCompatibility } from "../compatibility.js";
import type { Context } from "../context.js";

type CheckFlags = {
  readonly server: string;
};

const checkCommand = buildCommand<CheckFlags, [], Context>({
  docs: {
    brief: "Verify that a deployed stella API supports this CLI",
    fullDescription:
      "Checks the public MCP protocol revision, required capabilities, and the packaged CLI's full resource-scope surface. Older servers fall back to their legacy CLI version range. This command does not require authentication.",
  },
  func: async function func(this: Context, flags) {
    const result = await checkServerCompatibility(flags.server);
    if (Result.isError(result)) {
      return new Error(result.error.message);
    }

    const contract =
      result.value.serverRevision === undefined
        ? `legacy API contract ${result.value.apiProtocolVersion}`
        : `API protocol ${result.value.apiProtocolVersion}, server revision ${result.value.serverRevision}`;
    this.process.stdout.write(
      `Compatible: CLI ${result.value.cliVersion}, ${contract} at ${result.value.serverUrl}.\n`,
    );
    return undefined;
  },
  parameters: {
    flags: {
      server: {
        brief: "Stella API origin to verify",
        kind: "parsed",
        parse: (input: string) => input,
      },
    },
  },
});

export const compatibilityRoute: RouteMap<Context> = buildRouteMap({
  docs: { brief: "Check CLI and deployed API compatibility" },
  routes: { check: checkCommand },
});
