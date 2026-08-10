import { Result, TaggedError, type TaggedErrorClass } from "better-result";
import * as v from "valibot";

import packageJson from "../package.json" with { type: "json" };
import {
  AUTH_FETCH_TIMEOUT_MS,
  CLI_REQUIRED_RESOURCE_SCOPES,
} from "./auth/constants.js";
import {
  CLI_MINIMUM_SERVER_REVISION,
  CLI_REQUIRED_CAPABILITIES,
  CLI_SUPPORTED_API_PROTOCOLS,
} from "./generated/api-contract.js";
import { MCP_DISCOVERY_PATH, MCP_HTTP_PATH } from "./generated/mcp-contract.js";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const SEMVER_BUILD_PATTERN = /^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/u;
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const compatibilityMetadataSchema = v.looseObject({
  resource: v.pipe(v.string(), v.url()),
  scopes_supported: v.array(v.string()),
  stella_contract: v.optional(
    v.looseObject({
      protocol: positiveIntegerSchema,
      revision: positiveIntegerSchema,
      capabilities: v.record(v.string(), positiveIntegerSchema),
    }),
  ),
  // Transitional fallback for servers deployed before contract revisions.
  stella_compatibility: v.optional(
    v.strictObject({
      api_contract_version: positiveIntegerSchema,
      cli_version: v.strictObject({
        minimum: v.string(),
        maximum: v.string(),
      }),
    }),
  ),
});

type CompatibilityMetadata = v.InferOutput<typeof compatibilityMetadataSchema>;
type StellaContract = NonNullable<CompatibilityMetadata["stella_contract"]>;
type LegacyCompatibility = NonNullable<
  CompatibilityMetadata["stella_compatibility"]
>;

type SemverIdentifier =
  | { readonly type: "numeric"; readonly value: number }
  | { readonly type: "text"; readonly value: string };

type ParsedSemver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly SemverIdentifier[];
};

type NegotiatedContract =
  | {
      readonly apiProtocolVersion: number;
      readonly compatibilitySource: "contract";
      readonly serverRevision: number;
    }
  | {
      readonly apiProtocolVersion: number;
      readonly compatibilitySource: "legacy";
      readonly legacyCliMaximumVersion: string;
      readonly legacyCliMinimumVersion: string;
    };

export type CompatibilityReport = NegotiatedContract & {
  readonly cliVersion: string;
  readonly resource: string;
  readonly serverUrl: string;
};

const CompatibilityCheckErrorBase: TaggedErrorClass<"CompatibilityCheckError"> =
  TaggedError("CompatibilityCheckError");

export class CompatibilityCheckError extends CompatibilityCheckErrorBase<{
  message: string;
  cause?: unknown;
}> {}

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

const supportsProtocol = (protocol: number): boolean =>
  CLI_SUPPORTED_API_PROTOCOLS.some((supported) => supported === protocol);

const validateContract = (
  contract: StellaContract,
): Result<NegotiatedContract, CompatibilityCheckError> => {
  if (!supportsProtocol(contract.protocol)) {
    return Result.err(
      new CompatibilityCheckError({
        message: `Server API protocol ${contract.protocol} is incompatible; this CLI supports ${CLI_SUPPORTED_API_PROTOCOLS.join(", ")}.`,
      }),
    );
  }
  if (contract.revision < CLI_MINIMUM_SERVER_REVISION) {
    return Result.err(
      new CompatibilityCheckError({
        message: `Server contract revision ${contract.revision} is too old; this CLI requires revision ${CLI_MINIMUM_SERVER_REVISION} or newer.`,
      }),
    );
  }

  const missingCapabilities = Object.entries(CLI_REQUIRED_CAPABILITIES)
    .filter(
      ([name, requiredVersion]) =>
        (contract.capabilities[name] ?? 0) < requiredVersion,
    )
    .map(([name, requiredVersion]) => `${name}>=${requiredVersion}`);
  if (missingCapabilities.length > 0) {
    return Result.err(
      new CompatibilityCheckError({
        message: `Server contract is missing required ${missingCapabilities.length === 1 ? "capability" : "capabilities"}: ${missingCapabilities.join(", ")}.`,
      }),
    );
  }

  return Result.ok({
    apiProtocolVersion: contract.protocol,
    compatibilitySource: "contract",
    serverRevision: contract.revision,
  });
};

const validateLegacyCompatibility = (
  compatibility: LegacyCompatibility,
): Result<NegotiatedContract, CompatibilityCheckError> => {
  if (!supportsProtocol(compatibility.api_contract_version)) {
    return Result.err(
      new CompatibilityCheckError({
        message: `Server API contract ${compatibility.api_contract_version} is incompatible; this CLI supports ${CLI_SUPPORTED_API_PROTOCOLS.join(", ")}.`,
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
        message: `CLI ${packageJson.version} is incompatible with this legacy server; supported CLI versions are ${compatibility.cli_version.minimum} through ${compatibility.cli_version.maximum}, inclusive.`,
      }),
    );
  }

  return Result.ok({
    apiProtocolVersion: compatibility.api_contract_version,
    compatibilitySource: "legacy",
    legacyCliMaximumVersion: compatibility.cli_version.maximum,
    legacyCliMinimumVersion: compatibility.cli_version.minimum,
  });
};

const validateCompatibility = (
  metadata: CompatibilityMetadata,
  serverUrl: string,
): Result<CompatibilityReport, CompatibilityCheckError> => {
  let negotiated: Result<NegotiatedContract, CompatibilityCheckError>;
  if (metadata.stella_contract !== undefined) {
    negotiated = validateContract(metadata.stella_contract);
  } else if (metadata.stella_compatibility !== undefined) {
    negotiated = validateLegacyCompatibility(metadata.stella_compatibility);
  } else {
    negotiated = Result.err(
      new CompatibilityCheckError({
        message:
          "The server metadata does not advertise a stella compatibility contract.",
      }),
    );
  }
  if (Result.isError(negotiated)) {
    return Result.err(negotiated.error);
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
    MCP_HTTP_PATH,
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
    ...negotiated.value,
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
          message: `stella compatibility discovery at ${discoveryUrl.toString()} is absent or malformed. Deploy an API that advertises a stella compatibility contract before publishing this CLI.`,
        });
      }

      const result = validateCompatibility(parsed.output, serverUrl);
      if (Result.isError(result)) {
        throw result.error;
      }
      return result.value;
    },
  });
