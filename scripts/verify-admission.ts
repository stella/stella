import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { VerifyError } from "./verify-error";

export const BOTH_GATES_REFUSED = 75;
export const BOTH_GATES_MESSAGE =
  "verify: local and remote admission refused; CI will validate.";

type AdmissionOptions = {
  alreadyRemote: boolean;
  admitLocal: () => number;
  probeRemote: () => number;
  runLocal: () => number;
  runRemote: () => number;
  report: (message: string) => void;
};

/** Remote admission covers remote execution; configured gates remain mandatory. */
export const withCheckAdmission = ({
  alreadyRemote,
  admitLocal,
  probeRemote,
  runLocal,
  runRemote,
  report,
}: AdmissionOptions): number => {
  const admission = admitLocal();
  if (admission !== 0 && admission !== BOTH_GATES_REFUSED) {
    return admission;
  }
  const local = admission === 0 ? runLocal() : admission;
  if (local !== BOTH_GATES_REFUSED) {
    return local;
  }
  if (alreadyRemote) {
    report(BOTH_GATES_MESSAGE);
    return BOTH_GATES_REFUSED;
  }
  const probe = probeRemote();
  if (probe === BOTH_GATES_REFUSED) {
    report(BOTH_GATES_MESSAGE);
    return BOTH_GATES_REFUSED;
  }
  if (probe !== 0) {
    return probe;
  }
  const remote = runRemote();
  if (remote === BOTH_GATES_REFUSED) {
    report(BOTH_GATES_MESSAGE);
  }
  return remote;
};

export type HostConfig = {
  localGate: string[] | null;
  remote: string[] | null;
  installer: string[] | null;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const commandArguments = (value: unknown, name: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (arg): arg is string =>
        typeof arg === "string" && arg.length > 0 && !arg.includes("\0"),
    )
  ) {
    throw new VerifyError(
      `${name} must be a nonempty command array of NUL-free strings`,
    );
  }
  return value;
};
export const hostConfig = (): HostConfig => {
  const file =
    process.env["STELLA_VERIFY_CONFIG"] ??
    path.join(homedir(), ".config/stella/verify.json");
  const config: unknown = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf-8"))
    : {};
  if (!isRecord(config)) {
    throw new VerifyError(`${file} must contain an object`);
  }
  const optionalCommand = (
    name: string,
    fallback: [string, ...string[]],
  ): string[] | null => {
    const configured = config[name];
    if (configured !== undefined) {
      return commandArguments(configured, name);
    }
    const executable = fallback[0];
    return Bun.which(executable) === null ? null : fallback;
  };
  return {
    localGate: optionalCommand("localGate", ["load-admit", "--"]),
    remote: optionalCommand("remote", ["remote-check"]),
    installer: optionalCommand("installer", ["serial-install"]),
  };
};

type AdmitLocalOptions = {
  config: HostConfig;
  repo: string;
  command: readonly string[];
};

export const admitLocal = ({
  config,
  repo,
  command,
}: AdmitLocalOptions): number => {
  if (config.localGate === null) {
    return 0;
  }
  return Bun.spawnSync([...config.localGate, ...command], {
    cwd: repo,
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode;
};

export const probeRemote = (config: HostConfig, repo: string): number => {
  if (config.remote === null) {
    return BOTH_GATES_REFUSED;
  }
  return Bun.spawnSync([...config.remote, "--probe"], {
    cwd: repo,
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode;
};
