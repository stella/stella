import packageJson from "../../package.json";

/**
 * The sidecar's environment boundary. The desktop starts the sidecar with
 * the environment its harnesses need (`HOME`, `PATH`, proxies), and the
 * sidecar hands that on to each harness process unchanged, except for the
 * variables below, which are the sidecar's own.
 */

const VERSION_VARIABLE = "STELLA_SIDECAR_VERSION";
/**
 * Turns on the protocol log (`protocol-log.ts`) in `holder.log`: set it to
 * `redacted` in the environment the desktop app starts with. The holder
 * reads it when it starts, so a running holder keeps its setting until it
 * exits (idle, or replaced by another desktop release).
 */
const PROTOCOL_LOG_VARIABLE = "STELLA_AGENT_PROTOCOL_LOG";
/**
 * Extension ids besides the store's that may start the browser host,
 * separated by commas: an unpacked development build has its own.
 */
const BROWSER_EXTENSION_IDS_VARIABLE = "STELLA_BROWSER_EXTENSION_IDS";
/**
 * Set to `1` to let runs use the stella browser (`browser/stella-browser`)
 * when no extension is connected: a development switch, off by default.
 */
const STELLA_BROWSER_DEV_VARIABLE = "STELLA_BROWSER_DEV_HOST";
/**
 * The stella browser's test hooks. The sidecar build replaces the switch
 * with "0" (`scripts/build-sidecar.ts`), so a release build reads none of
 * the others: the browser to run instead of the installed one (CI has no
 * member's install, and tests on a shared computer must never start an app
 * bundle), where the fixture site's name resolves and its certificate, a
 * file each protocol method is recorded in as it is first sent, and a file
 * for the browser's own error output.
 */
const STELLA_BROWSER_TEST_HOOKS_VARIABLE = "STELLA_BROWSER_TEST_HOOKS";
const STELLA_BROWSER_TEST_VARIABLES = {
  executable: "STELLA_BROWSER_TEST_EXECUTABLE",
  hostRules: "STELLA_BROWSER_TEST_HOST_RULES",
  spki: "STELLA_BROWSER_TEST_SPKI",
  methodLog: "STELLA_BROWSER_TEST_METHOD_LOG",
  browserLog: "STELLA_BROWSER_TEST_BROWSER_LOG",
} as const;
const SIDECAR_VARIABLES: ReadonlySet<string> = new Set([
  VERSION_VARIABLE,
  PROTOCOL_LOG_VARIABLE,
  BROWSER_EXTENSION_IDS_VARIABLE,
  STELLA_BROWSER_DEV_VARIABLE,
  STELLA_BROWSER_TEST_HOOKS_VARIABLE,
  ...Object.values(STELLA_BROWSER_TEST_VARIABLES),
]);

const PROTOCOL_LOG_SETTINGS = ["off", "redacted"] as const;
type ProtocolLogSetting = (typeof PROTOCOL_LOG_SETTINGS)[number];

/** The protocol log setting; unset is `off`, a value not listed is reported. */
export type ProtocolLogSettingRead =
  { type: "set"; setting: ProtocolLogSetting } | { type: "unrecognized" };

const isProtocolLogSetting = (value: string): value is ProtocolLogSetting =>
  PROTOCOL_LOG_SETTINGS.some((setting) => setting === value);

export const protocolLogSetting = (): ProtocolLogSettingRead => {
  const value = process.env[PROTOCOL_LOG_VARIABLE] ?? "off";
  return isProtocolLogSetting(value)
    ? { type: "set", setting: value }
    : { type: "unrecognized" };
};

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
      value === undefined || SIDECAR_VARIABLES.has(name) ? [] : [[name, value]],
    ),
  );

/** Chrome's extension ids: 32 letters from a to p. */
const EXTENSION_ID = /^[a-p]{32}$/u;

/** The development extension ids the environment names; others are ignored. */
export const extraBrowserExtensionIds = (): string[] =>
  (process.env[BROWSER_EXTENSION_IDS_VARIABLE] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => EXTENSION_ID.test(id));

/** The member's home folder; `null` when the environment names none. */
export const homeFolder = (): string | null => {
  const home = process.env["HOME"];
  return home === undefined || home === "" ? null : home;
};

/** Whether the development switch lets runs use the stella browser. */
export const stellaBrowserDevHost = (): boolean =>
  process.env[STELLA_BROWSER_DEV_VARIABLE] === "1";

/** What a test set for the stella browser; see `STELLA_BROWSER_TEST_HOOKS_VARIABLE`. */
export type StellaBrowserTestHooks = {
  /** The browser to run instead of the installed one. */
  executable: string;
  /** Launch flags for the fixture site: where its name resolves, and its certificate. */
  args: string[];
  /** A file each protocol method is appended to as it is first sent. */
  methodLog: string | null;
  /** A file the browser's own error output goes to, to tell why it is slow or failed. */
  browserLog: string | null;
};

const setValue = (name: string): string | null => {
  const value = process.env[name];
  return value === undefined || value === "" ? null : value;
};

/** The hooks a test set; null in a release build, or when no test set them. */
export const stellaBrowserTestHooks = (): StellaBrowserTestHooks | null => {
  // A literal key: the build replaces exactly this expression.
  if (process.env["STELLA_BROWSER_TEST_HOOKS"] !== "1") {
    return null;
  }
  const executable = setValue(STELLA_BROWSER_TEST_VARIABLES.executable);
  if (executable === null) {
    return null;
  }
  const hostRules = setValue(STELLA_BROWSER_TEST_VARIABLES.hostRules);
  const spki = setValue(STELLA_BROWSER_TEST_VARIABLES.spki);
  return {
    executable,
    args: [
      ...(hostRules === null ? [] : [`--host-resolver-rules=${hostRules}`]),
      ...(spki === null
        ? []
        : [`--ignore-certificate-errors-spki-list=${spki}`]),
    ],
    methodLog: setValue(STELLA_BROWSER_TEST_VARIABLES.methodLog),
    browserLog: setValue(STELLA_BROWSER_TEST_VARIABLES.browserLog),
  };
};
