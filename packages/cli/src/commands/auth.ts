// `stella auth login|logout|whoami|switch` (spec 051 Phase 2).

import { buildCommand, buildRouteMap } from "@stricli/core";
import type { RouteMap } from "@stricli/core";
import { Result } from "better-result";

import {
  CLI_DEFAULT_SCOPES,
  CLI_KNOWN_SCOPES,
  CLI_REQUIRED_SCOPES,
} from "../auth/constants.js";
import { login } from "../auth/login.js";
import { logout, switchOrg, whoami } from "../auth/manage.js";
import { parseScopesFlag } from "../auth/scopes.js";
import { resolveServerUrl } from "../auth/server-resolution.js";
import type { Context } from "../context.js";
import { STELLA_API_KEY } from "../env.js";

const parseString = (input: string): string => input;

const stringFlag = (brief: string) =>
  ({ brief, kind: "parsed", optional: true, parse: parseString }) as const;

const requiredStringFlag = (brief: string) =>
  ({ brief, kind: "parsed", parse: parseString }) as const;

const formatDate = (epochMs: number): string => new Date(epochMs).toISOString();

type LoginFlags = {
  readonly keychain: boolean;
  readonly org: string | undefined;
  readonly scopes: string | undefined;
  readonly server: string | undefined;
};

type ServerOrgFlags = {
  readonly org: string | undefined;
  readonly server: string | undefined;
};

type SwitchFlags = {
  readonly org: string;
  readonly server: string | undefined;
};

const loginCommand = buildCommand<LoginFlags, [], Context>({
  docs: {
    brief: "Sign in to a stella server via the browser (PKCE loopback flow)",
    fullDescription:
      "Opens the stella sign-in page in your default browser and waits for the redirect on an ephemeral localhost port. If the browser can't reach this machine (SSH/remote/headless), paste the redirected URL or the bare authorization code back into the prompt instead.",
  },
  func: async function func(this: Context, flags) {
    let requestedScopes: readonly string[] = CLI_DEFAULT_SCOPES;
    let requiredScopes: readonly string[] = CLI_REQUIRED_SCOPES;
    if (flags.scopes) {
      const parsedScopes = parseScopesFlag(flags.scopes);
      if (Result.isError(parsedScopes)) {
        return new Error(parsedScopes.error.message);
      }
      requestedScopes = parsedScopes.value;
      requiredScopes = parsedScopes.value;
    }

    if (!flags.keychain) {
      this.process.stdout.write(
        "Note: --no-keychain has no effect yet; credentials are always stored at ~/.config/stella/credentials.json (mode 0600). OS keychain support is a follow-up.\n",
      );
    }

    const result = await login(this.process, {
      configDir: this.configDir,
      orgHint: flags.org,
      registrationScopes: CLI_KNOWN_SCOPES,
      requestedScopes,
      requiredScopes,
      serverFlag: flags.server,
    });

    if (Result.isError(result)) {
      return new Error(result.error.message);
    }

    const refreshNote = result.value.hasRefreshToken
      ? ""
      : "No refresh token was issued (the server has not enabled offline_access yet); re-run `stella auth login` once this token expires.\n";
    const lines = [
      `Signed in to ${result.value.serverUrl} (org ${result.value.orgId}).`,
      `Granted scopes: ${result.value.grantedScopes}`,
      `Access token expires: ${formatDate(result.value.expiresAt)}`,
    ];
    this.process.stdout.write(`${lines.join("\n")}\n${refreshNote}`);
    return undefined;
  },
  parameters: {
    flags: {
      keychain: {
        brief:
          "Use the OS keychain for storage (currently always falls back to the XDG credentials file; see --help)",
        default: true,
        kind: "boolean",
      },
      org: stringFlag(
        "Organization slug to select in the browser when prompted (label only, not enforced server-side; see --help)",
      ),
      scopes: stringFlag(
        `Comma-separated OAuth scopes to request (default: ${CLI_DEFAULT_SCOPES.join(",")})`,
      ),
      server: stringFlag("Stella API origin to sign in to"),
    },
  },
});

const whoamiCommand = buildCommand<ServerOrgFlags, [], Context>({
  docs: { brief: "Show the signed-in organization, scopes, and token expiry" },
  func: async function func(this: Context, flags) {
    const serverUrlResult = await resolveServerUrl(
      this.configDir,
      flags.server,
    );
    if (Result.isError(serverUrlResult)) {
      return new Error(serverUrlResult.error.message);
    }

    // `STELLA_API_KEY` takes precedence over `credentials.json` for every other
    // command, so reporting the stored credential here would describe an
    // identity nothing is actually running as. The key is opaque to the CLI (it
    // is a random secret, not a JWT), so the honest answer is which credential
    // is in effect and where it came from, not decoded claims.
    if (STELLA_API_KEY !== undefined && STELLA_API_KEY !== "") {
      this.process.stdout.write(
        [
          `Server: ${serverUrlResult.value}`,
          "Credential: machine API key (STELLA_API_KEY)",
          "Stored credentials are ignored while this variable is set.",
          "",
        ].join("\n"),
      );
      return undefined;
    }

    const result = await whoami(
      this.configDir,
      serverUrlResult.value,
      flags.org,
    );
    if (Result.isError(result)) {
      return new Error(result.error.message);
    }

    const info = result.value;
    const lines = [
      `Server: ${info.serverUrl}`,
      `Organization: ${info.orgLabel ? `${info.orgLabel} (${info.orgId})` : info.orgId}`,
      `Scopes: ${info.scope}`,
      `Expires: ${formatDate(info.expiresAt)}${info.isExpired ? " (expired)" : ""}`,
      `Refresh token: ${info.hasRefreshToken ? "yes" : "no"}`,
    ];
    if (info.claims?.sub) {
      lines.push(`Subject: ${info.claims.sub}`);
    }
    this.process.stdout.write(`${lines.join("\n")}\n`);
    return undefined;
  },
  parameters: {
    flags: {
      org: stringFlag(
        "Organization to inspect (default: this server's default org)",
      ),
      server: stringFlag(
        "Stella API origin to inspect (default: resolved server)",
      ),
    },
  },
});

const logoutCommand = buildCommand<ServerOrgFlags, [], Context>({
  docs: { brief: "Remove a stored stella credential" },
  func: async function func(this: Context, flags) {
    const serverUrlResult = await resolveServerUrl(
      this.configDir,
      flags.server,
    );
    if (Result.isError(serverUrlResult)) {
      return new Error(serverUrlResult.error.message);
    }

    const result = await logout(
      this.configDir,
      serverUrlResult.value,
      flags.org,
    );
    if (Result.isError(result)) {
      return new Error(result.error.message);
    }

    this.process.stdout.write(
      `Signed out of ${serverUrlResult.value} (org ${result.value.orgId}).\n`,
    );
    return undefined;
  },
  parameters: {
    flags: {
      org: stringFlag(
        "Organization to sign out of (default: the only signed-in org)",
      ),
      server: stringFlag(
        "Stella API origin to sign out of (default: resolved server)",
      ),
    },
  },
});

const switchCommand = buildCommand<SwitchFlags, [], Context>({
  docs: {
    brief:
      "Switch the default organization for a server (no re-auth if already signed in)",
  },
  func: async function func(this: Context, flags) {
    const serverUrlResult = await resolveServerUrl(
      this.configDir,
      flags.server,
    );
    if (Result.isError(serverUrlResult)) {
      return new Error(serverUrlResult.error.message);
    }

    const result = await switchOrg(
      this.configDir,
      serverUrlResult.value,
      flags.org,
    );
    if (Result.isError(result)) {
      return new Error(result.error.message);
    }

    this.process.stdout.write(
      `Default organization for ${serverUrlResult.value} is now ${result.value.orgId}.\n`,
    );
    return undefined;
  },
  parameters: {
    flags: {
      org: requiredStringFlag("Organization to switch to"),
      server: stringFlag("Stella API origin (default: resolved server)"),
    },
  },
});

export const authRoute: RouteMap<Context> = buildRouteMap({
  docs: { brief: "Manage stella authentication" },
  routes: {
    login: loginCommand,
    logout: logoutCommand,
    switch: switchCommand,
    whoami: whoamiCommand,
  },
});
