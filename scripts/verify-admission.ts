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

/** Remote admission covers the remote execution; the local gate is never bypassed. */
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
  localGate: string[];
  remote: string[];
  installer: string[];
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
  if (!existsSync(file)) {
    return {
      localGate: ["load-admit", "--"],
      remote: ["remote-check"],
      installer: ["serial-install"],
    };
  }
  const config: unknown = JSON.parse(readFileSync(file, "utf-8"));
  if (!isRecord(config)) {
    throw new VerifyError(`${file} must contain an object`);
  }
  return {
    localGate: commandArguments(
      config["localGate"] ?? ["load-admit", "--"],
      "localGate",
    ),
    remote: commandArguments(config["remote"] ?? ["remote-check"], "remote"),
    installer: commandArguments(
      config["installer"] ?? ["serial-install"],
      "installer",
    ),
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
}: AdmitLocalOptions): number =>
  Bun.spawnSync([...config.localGate, ...command], {
    cwd: repo,
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode;

export const probeRemote = (config: HostConfig, repo: string): number =>
  Bun.spawnSync([...config.remote, "--probe"], {
    cwd: repo,
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode;
