import { readFileSync } from "node:fs";

// Every watched file and directory costs a descriptor, and the table is
// shared by the whole machine: a runner that starts near the ceiling takes
// down unrelated processes with it, so it refuses instead.
export const MAX_HOST_FILE_USAGE_RATIO = 0.7;

export type HostFileUsage = {
  max: number;
  open: number;
};

export type HostAdmission =
  | { type: "admit" }
  | { type: "admit-unverified"; reason: string }
  | { type: "refuse"; message: string };

type DecideHostAdmissionOptions = {
  maxRatio?: number;
  usage: HostFileUsage | null;
};

export const decideHostAdmission = ({
  maxRatio = MAX_HOST_FILE_USAGE_RATIO,
  usage,
}: DecideHostAdmissionOptions): HostAdmission => {
  if (usage === null || !(usage.max > 0) || !(usage.open >= 0)) {
    return {
      type: "admit-unverified",
      reason: "Could not read the host open-file usage; starting unchecked.",
    };
  }
  const ratio = usage.open / usage.max;
  if (ratio <= maxRatio) {
    return { type: "admit" };
  }
  return {
    type: "refuse",
    message: `Refusing to start: the host has ${String(usage.open)} of ${String(usage.max)} system open files in use (${String(Math.round(ratio * 100))}%, limit ${String(Math.round(maxRatio * 100))}%). Stop idle dev stacks (bun run agent:down) and retry.`,
  };
};

const toCount = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

// macOS: `sysctl -n kern.num_files kern.maxfiles` prints one value per line.
export const parseDarwinFileUsage = (output: string): HostFileUsage | null => {
  const [open, max] = output.trim().split(/\s+/u).map(toCount);
  return open === undefined ||
    max === undefined ||
    open === null ||
    max === null
    ? null
    : { max, open };
};

// Linux: /proc/sys/fs/file-nr is "allocated unused maximum".
export const parseLinuxFileNr = (content: string): HostFileUsage | null => {
  const [allocated, , max] = content.trim().split(/\s+/u).map(toCount);
  return allocated === undefined ||
    max === undefined ||
    allocated === null ||
    max === null
    ? null
    : { max, open: allocated };
};

export const probeHostFileUsage = (): HostFileUsage | null => {
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(
      ["sysctl", "-n", "kern.num_files", "kern.maxfiles"],
      {
        stderr: "ignore",
        stdout: "pipe",
      },
    );
    return result.success
      ? parseDarwinFileUsage(result.stdout.toString())
      : null;
  }
  if (process.platform === "linux") {
    try {
      return parseLinuxFileNr(readFileSync("/proc/sys/fs/file-nr", "utf-8"));
    } catch {
      // An unreadable probe admits with a warning; see decideHostAdmission.
      return null;
    }
  }
  return null;
};
