import packageJson from "../../package.json";

/**
 * The sidecar's environment boundary. The desktop starts the sidecar with
 * the environment its harnesses need (`HOME`, `PATH`, proxies), and the
 * sidecar hands that on to each harness process unchanged.
 */

const VERSION_VARIABLE = "STELLA_SIDECAR_VERSION";

/**
 * The version the sidecar reports: stamped into a compiled build by
 * `scripts/build-sidecar.ts` as the desktop's own version, else the
 * package's.
 */
export const sidecarVersion = (): string =>
  // A literal key: the build replaces exactly this expression.
  process.env["STELLA_SIDECAR_VERSION"] ?? packageJson.version;

/** The environment a harness process starts from. */
export const harnessEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      value === undefined || name === VERSION_VARIABLE ? [] : [[name, value]],
    ),
  );
