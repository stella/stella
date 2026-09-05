import { buildCommand, buildRouteMap } from "@stricli/core";
import type { RouteMap } from "@stricli/core";
import { panic, Result } from "better-result";

import { resolveServerUrl } from "../auth/server-resolution.js";
import { CliCommandError } from "../cli-exit-code.js";
import {
  checkServerCompatibility,
  type CompatibilityReport,
} from "../compatibility.js";
import type { Context } from "../context.js";
import { EXIT_CODES } from "../mcp-constants.js";
import { buildServerFlag } from "../output-flags.js";

type CheckFlags = {
  readonly server: string | undefined;
};

const checkCommand = buildCommand<CheckFlags, [], Context>({
  docs: {
    brief: "Verify that a deployed stella API supports this CLI",
    fullDescription:
      "Checks the public MCP protocol revision, required capabilities, and the packaged CLI's full resource-scope surface. Older servers fall back to their legacy CLI version range. This command does not require authentication.",
  },
  func: async function func(this: Context, flags) {
    // Unauthenticated, so it resolves its own origin rather than reading the
    // context's: same precedence as every other command (flag > env var >
    // signed-in default), instead of demanding an explicit `--server`.
    const serverUrl = await resolveServerUrl({
      configDir: this.configDir,
      flagValue: flags.server,
    });
    if (Result.isError(serverUrl)) {
      return new CliCommandError(serverUrl.error.message, EXIT_CODES.auth);
    }
    const result = await checkServerCompatibility(serverUrl.value);
    if (Result.isError(result)) {
      // An incompatible or unreachable server is a server-class failure.
      return new CliCommandError(result.error.message, EXIT_CODES.server);
    }

    const contract = describeContract(result.value);
    this.process.stdout.write(
      `Compatible: CLI ${result.value.cliVersion}, ${contract} at ${result.value.serverUrl}.\n`,
    );
    return undefined;
  },
  parameters: { flags: buildServerFlag() },
});

const describeContract = (report: CompatibilityReport): string => {
  switch (report.compatibilitySource) {
    case "contract":
      return `API protocol ${report.apiProtocolVersion}, server revision ${report.serverRevision}`;
    case "legacy":
      return `legacy API contract ${report.apiProtocolVersion}`;
    default: {
      report satisfies never;
      return panic(`Unhandled report: ${String(report)}`);
    }
  }
};

export const compatibilityRoute: RouteMap<Context> = buildRouteMap({
  docs: { brief: "Check CLI and deployed API compatibility" },
  routes: { check: checkCommand },
});
