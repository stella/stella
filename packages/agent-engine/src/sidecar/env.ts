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
const SIDECAR_VARIABLES: ReadonlySet<string> = new Set([
  VERSION_VARIABLE,
  PROTOCOL_LOG_VARIABLE,
  BROWSER_EXTENSION_IDS_VARIABLE,
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
