import { Result } from "better-result";
import * as v from "valibot";

import packageJson from "../package.json" with { type: "json" };
import {
  AUTH_FETCH_TIMEOUT_MS,
  CLI_REQUIRED_RESOURCE_SCOPES,
} from "./auth/constants.js";
import { CliBaseError } from "./auth/errors.js";

const MCP_DISCOVERY_PATH = "/.well-known/oauth-protected-resource/mcp";
export const CLI_SUPPORTED_API_CONTRACT_VERSION = 1;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SEMVER_BUILD_PATTERN = /^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/u;

const compatibilityMetadataSchema = v.looseObject({
  resource: v.pipe(v.string(), v.url()),
  scopes_supported: v.array(v.string()),
  stella_compatibility: v.strictObject({
    api_contract_version: v.pipe(v.number(), v.integer()),
    cli_version: v.strictObject({
      minimum: v.string(),
      maximum: v.string(),
    }),
  }),
});

type CompatibilityMetadata = {
  readonly resource: string;
  readonly scopes_supported: readonly string[];
  readonly stella_compatibility: {
    readonly api_contract_version: number;
    readonly cli_version: {
      readonly minimum: string;
      readonly maximum: string;
    };
  };
};

type SemverIdentifier =
  | { readonly type: "numeric"; readonly value: number }
  | { readonly type: "text"; readonly value: string };

type ParsedSemver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly SemverIdentifier[];
};

export type CompatibilityReport = {
  readonly apiContractVersion: number;
  readonly cliMaximumVersion: string;
  readonly cliMinimumVersion: string;
  readonly cliVersion: string;
  readonly resource: string;
  readonly serverUrl: string;
};

export class CompatibilityCheckError extends CliBaseError<"CompatibilityCheckError"> {
  override readonly name = "CompatibilityCheckError";
  override readonly cause?: unknown;

  constructor(props: { message: string; cause?: unknown }) {
    super("CompatibilityCheckError", props.message);
    this.cause = props.cause;
  }
}

const parseSemver = (input: string): ParsedSemver | undefined => {
  const buildParts = input.split("+");
  const version = buildParts.at(0);
  const build = buildParts.at(1);
  if (
    version === undefined ||
    buildParts.length > 2 ||
    (build !== undefined && !SEMVER_BUILD_PATTERN.test(build))
  ) {
    return undefined;
  }

  const match = SEMVER_PATTERN.exec(version);
  if (match === null) {
    return undefined;
  }

  const prerelease = match
    .at(4)
    ?.split(".")
    .map((identifier) => {
      if (/^(0|[1-9]\d*)$/u.test(identifier)) {
        return { type: "numeric", value: Number(identifier) } as const;
      }
      return { type: "text", value: identifier } as const;
    });

  return {
    major: Number(match.at(1)),
    minor: Number(match.at(2)),
    patch: Number(match.at(3)),
    prerelease: prerelease ?? [],
  };
};

const compareIdentifiers = (
  left: SemverIdentifier,
  right: SemverIdentifier,
): number => {
  if (left.type === "numeric" && right.type === "numeric") {
    return left.value - right.value;
  }
  if (left.type === "numeric") {
    return -1;
  }
  if (right.type === "numeric") {
    return 1;
  }
  if (left.value === right.value) {
    return 0;
  }
  return left.value < right.value ? -1 : 1;
};

const compareSemver = (left: ParsedSemver, right: ParsedSemver): number => {
  const coreComparison =
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch;
  if (coreComparison !== 0) {
    return coreComparison;
  }
  if (left.prerelease.length === 0) {
    return right.prerelease.length === 0 ? 0 : 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }

  const identifierCount = Math.max(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left.prerelease.at(index);
    const rightIdentifier = right.prerelease.at(index);
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
};

const validateCompatibility = (
  metadata: CompatibilityMetadata,
  serverUrl: string,
): Result<CompatibilityReport, CompatibilityCheckError> => {
  const compatibility = metadata.stella_compatibility;
  if (
    compatibility.api_contract_version !== CLI_SUPPORTED_API_CONTRACT_VERSION
  ) {
    return Result.err(
      new CompatibilityCheckError({
        message: `Server API contract ${compatibility.api_contract_version} is incompatible; this CLI requires contract ${CLI_SUPPORTED_API_CONTRACT_VERSION}.`,
      }),
    );
  }

  const cliVersion = parseSemver(packageJson.version);
  const minimum = parseSemver(compatibility.cli_version.minimum);
  const maximum = parseSemver(compatibility.cli_version.maximum);
  if (
    cliVersion === undefined ||
    minimum === undefined ||
    maximum === undefined
  ) {
    return Result.err(
      new CompatibilityCheckError({
        message: `Server compatibility metadata contains an invalid semantic version range: ${compatibility.cli_version.minimum} - ${compatibility.cli_version.maximum}.`,
      }),
    );
  }
  if (compareSemver(minimum, maximum) > 0) {
    return Result.err(
      new CompatibilityCheckError({
        message: `Server compatibility metadata has an inverted CLI version range: ${compatibility.cli_version.minimum} - ${compatibility.cli_version.maximum}.`,
      }),
    );
  }
  if (
    compareSemver(cliVersion, minimum) < 0 ||
    compareSemver(cliVersion, maximum) > 0
  ) {
    return Result.err(
      new CompatibilityCheckError({
        message: `CLI ${packageJson.version} is incompatible with this server; supported CLI versions are ${compatibility.cli_version.minimum} through ${compatibility.cli_version.maximum}, inclusive.`,
      }),
    );
  }

  const supportedScopes = new Set(metadata.scopes_supported);
  const missingScopes = CLI_REQUIRED_RESOURCE_SCOPES.filter(
    (scope) => !supportedScopes.has(scope),
  );
  if (missingScopes.length > 0) {
    return Result.err(
      new CompatibilityCheckError({
        message: `Server protected-resource metadata is missing required ${missingScopes.length === 1 ? "scope" : "scopes"}: ${missingScopes.join(", ")}.`,
      }),
    );
  }

  const expectedResource = new URL(
    "/mcp",
    `${serverUrl.replace(/\/$/u, "")}/`,
  ).toString();
  if (metadata.resource !== expectedResource) {
    return Result.err(
      new CompatibilityCheckError({
        message: `Server metadata advertises resource ${metadata.resource}, but this CLI would connect to ${expectedResource}.`,
      }),
    );
  }

  return Result.ok({
    apiContractVersion: compatibility.api_contract_version,
    cliMaximumVersion: compatibility.cli_version.maximum,
    cliMinimumVersion: compatibility.cli_version.minimum,
    cliVersion: packageJson.version,
    resource: metadata.resource,
    serverUrl,
  });
};

export const checkServerCompatibility = async (
  serverUrl: string,
): Promise<Result<CompatibilityReport, CompatibilityCheckError>> =>
  await Result.tryPromise({
    catch: (cause) =>
      cause instanceof CompatibilityCheckError
        ? cause
        : new CompatibilityCheckError({
            cause,
            message: `Could not check stella compatibility at ${serverUrl}: ${cause instanceof Error ? cause.message : "unknown error"}.`,
          }),
    try: async () => {
      const discoveryUrl = new URL(
        MCP_DISCOVERY_PATH,
        `${serverUrl.replace(/\/$/u, "")}/`,
      );
      const response = await fetch(discoveryUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(AUTH_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new CompatibilityCheckError({
          message: `Stella compatibility discovery responded ${response.status} at ${discoveryUrl.toString()}. Deploy an API that exposes the public compatibility contract before publishing this CLI.`,
        });
      }

      const body: unknown = await response.json();
      const parsed = v.safeParse(compatibilityMetadataSchema, body);
      if (!parsed.success) {
        throw new CompatibilityCheckError({
          message: `Stella compatibility discovery at ${discoveryUrl.toString()} is absent or malformed. Deploy an API that advertises stella_compatibility before publishing this CLI.`,
        });
      }

      const result = validateCompatibility(parsed.output, serverUrl);
      if (Result.isError(result)) {
        throw result.error;
      }
      return result.value;
    },
  });
