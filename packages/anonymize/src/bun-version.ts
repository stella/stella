const MINIMUM_BUN_MAJOR = 1;
const MINIMUM_BUN_MINOR = 4;
const BUN_VERSION_PATTERN =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

export const MINIMUM_SUPPORTED_BUN_VERSION = "1.4.0";

export const assertSupportedBunVersion = (bunVersion?: string): void => {
  if (bunVersion === undefined) {
    return;
  }

  const match = BUN_VERSION_PATTERN.exec(bunVersion);
  const { major, minor, patch, prerelease } = match?.groups ?? {};
  if (major === undefined || minor === undefined || patch === undefined) {
    throw unsupportedBunVersionError(bunVersion);
  }

  const majorNumber = Number(major);
  const minorNumber = Number(minor);
  const patchNumber = Number(patch);
  if (
    !Number.isSafeInteger(majorNumber) ||
    !Number.isSafeInteger(minorNumber) ||
    !Number.isSafeInteger(patchNumber)
  ) {
    throw unsupportedBunVersionError(bunVersion);
  }

  const coreVersionIsNewer =
    majorNumber > MINIMUM_BUN_MAJOR ||
    (majorNumber === MINIMUM_BUN_MAJOR &&
      (minorNumber > MINIMUM_BUN_MINOR ||
        (minorNumber === MINIMUM_BUN_MINOR && patchNumber > 0)));
  const minimumReleaseIsSupported =
    majorNumber === MINIMUM_BUN_MAJOR &&
    minorNumber === MINIMUM_BUN_MINOR &&
    patchNumber === 0 &&
    prerelease === undefined;
  if (!coreVersionIsNewer && !minimumReleaseIsSupported) {
    throw unsupportedBunVersionError(bunVersion);
  }
};

export const assertSupportedBunRuntime = (): void => {
  const runtime: unknown = globalThis;
  if (!hasBunRuntime(runtime)) {
    return;
  }
  const bun = runtime.Bun;
  if (
    typeof bun !== "object" ||
    bun === null ||
    !("version" in bun) ||
    typeof bun.version !== "string"
  ) {
    throw unsupportedBunVersionError("unknown");
  }
  assertSupportedBunVersion(bun.version);
};

const hasBunRuntime = (runtime: unknown): runtime is { Bun: unknown } =>
  typeof runtime === "object" && runtime !== null && "Bun" in runtime;

const unsupportedBunVersionError = (bunVersion: string): Error =>
  new Error(
    `Bun ${bunVersion} is unsupported; @stll/anonymize requires Bun >=${MINIMUM_SUPPORTED_BUN_VERSION}. Upgrade Bun before loading the native SDK.`,
  );
