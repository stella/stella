import { panic, Result, TaggedError } from "better-result";

/** The NODE_ENV values a server process accepts. */
export const NODE_ENV = {
  development: "development",
  test: "test",
  staging: "staging",
  production: "production",
} as const;

type KnownNodeEnv = (typeof NODE_ENV)[keyof typeof NODE_ENV];

const KNOWN_NODE_ENVS: readonly KnownNodeEnv[] = Object.values(NODE_ENV);

const isKnownNodeEnv = (value: string): value is KnownNodeEnv =>
  KNOWN_NODE_ENVS.some((known) => known === value);

/**
 * The runtime NODE_ENV, `unset` when absent or empty. A label for messages
 * and the few checks that name one exact environment; policy reads the mode.
 */
export type NodeEnvLabel = KnownNodeEnv | "unset";

const LOCAL_NODE_ENVS: ReadonlySet<NodeEnvLabel> = new Set([
  NODE_ENV.development,
  NODE_ENV.test,
]);

export const RUNTIME_MODE = {
  strict: "strict",
  open: "open",
} as const;

/**
 * Whether local development capabilities are available to this process.
 * Anything short of an explicit runtime opt-in is `strict`.
 */
export type RuntimeMode =
  | { readonly mode: typeof RUNTIME_MODE.strict }
  | { readonly mode: typeof RUNTIME_MODE.open };

export type ResolvedRuntime = {
  readonly runtimeMode: RuntimeMode;
  readonly nodeEnv: NodeEnvLabel;
  /**
   * A test run the harness opened: NODE_ENV=test with the local development
   * opt-in. Never true for a strict process, so nothing gated on it can
   * relax a strict runtime.
   */
  readonly isLocalTestRun: boolean;
};

export const BUILD_KIND = {
  source: "source",
  release: "release",
} as const;

export type BuildKind = (typeof BUILD_KIND)[keyof typeof BUILD_KIND];

/** The runtime opt-in to local development capabilities, and its one value. */
export const LOCAL_DEV_OPT_IN = {
  name: "STELLA_LOCAL_DEV",
  value: "1",
} as const;

export class RuntimeModeConfigurationError extends TaggedError(
  "RuntimeModeConfigurationError",
)<{ message: string }> {}

type ResolveRuntimeModeInput = {
  nodeEnv: string | undefined;
  localDevOptIn: string | undefined;
  buildKind: BuildKind;
};

const configurationError = (message: string) =>
  Result.err(new RuntimeModeConfigurationError({ message }));

const nodeEnvLabel = (
  nodeEnv: string | undefined,
): Result<NodeEnvLabel, RuntimeModeConfigurationError> => {
  if (nodeEnv === undefined || nodeEnv === "") {
    return Result.ok("unset");
  }
  if (isKnownNodeEnv(nodeEnv)) {
    return Result.ok(nodeEnv);
  }
  return configurationError(
    `NODE_ENV="${nodeEnv}" is not a recognized environment. Set one of ${KNOWN_NODE_ENVS.join(", ")}.`,
  );
};

/**
 * Local development capabilities require an explicit runtime opt-in: a local
 * NODE_ENV together with STELLA_LOCAL_DEV=1, in a build that is not a release.
 * An opt-in that cannot be honoured is a configuration error, never a silent
 * downgrade.
 */
export const resolveRuntimeMode = ({
  nodeEnv,
  localDevOptIn,
  buildKind,
}: ResolveRuntimeModeInput): Result<
  ResolvedRuntime,
  RuntimeModeConfigurationError
> => {
  const resolvedLabel = nodeEnvLabel(nodeEnv);
  if (Result.isError(resolvedLabel)) {
    return Result.err(resolvedLabel.error);
  }
  const label = resolvedLabel.value;
  const strict = {
    runtimeMode: { mode: RUNTIME_MODE.strict },
    nodeEnv: label,
    isLocalTestRun: false,
  } as const satisfies ResolvedRuntime;

  if (localDevOptIn === undefined || localDevOptIn === "") {
    return Result.ok(strict);
  }
  if (localDevOptIn !== LOCAL_DEV_OPT_IN.value) {
    return configurationError(
      `${LOCAL_DEV_OPT_IN.name} accepts only "${LOCAL_DEV_OPT_IN.value}".`,
    );
  }
  if (buildKind === BUILD_KIND.release) {
    return configurationError(
      `${LOCAL_DEV_OPT_IN.name} is not available in a release build.`,
    );
  }
  if (!LOCAL_NODE_ENVS.has(label)) {
    return configurationError(
      `${LOCAL_DEV_OPT_IN.name}=${LOCAL_DEV_OPT_IN.value} requires NODE_ENV=${NODE_ENV.development} or ${NODE_ENV.test}; NODE_ENV is ${label}.`,
    );
  }
  return Result.ok({
    runtimeMode: { mode: RUNTIME_MODE.open },
    nodeEnv: label,
    isLocalTestRun: label === NODE_ENV.test,
  });
};

// Replaced with `true` by `bun build --define __STELLA_RELEASE__=true` on
// published artifacts; never defined for source runs, where a bare read would
// throw. `typeof` is the only safe probe of an undeclared global.
declare const __STELLA_RELEASE__: boolean | undefined;

export const currentBuildKind = (): BuildKind =>
  typeof __STELLA_RELEASE__ === "boolean" && __STELLA_RELEASE__
    ? BUILD_KIND.release
    : BUILD_KIND.source;

/**
 * The runtime mode of this process. Both keys are read through an alias of
 * the environment object: a bundler inlines `process.env.NODE_ENV` at build
 * time, and the mode must follow the environment the process runs in.
 */
export const readRuntimeMode = (): ResolvedRuntime => {
  const runtimeEnv = process.env;
  const resolved = resolveRuntimeMode({
    nodeEnv: runtimeEnv.NODE_ENV,
    localDevOptIn: runtimeEnv[LOCAL_DEV_OPT_IN.name],
    buildKind: currentBuildKind(),
  });
  if (Result.isError(resolved)) {
    return panic(resolved.error.message);
  }
  return resolved.value;
};
