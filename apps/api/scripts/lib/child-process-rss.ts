// The resident memory of this process's children: the TypeScript 7 compiler
// runs as one, so the generator's own peak says nothing about the program.
import { Result } from "better-result";
import { readFileSync } from "node:fs";

const MIB = 1024;

const childPids = (): string[] => {
  if (process.platform === "linux") {
    const listed = Result.try(() =>
      readFileSync(
        `/proc/${process.pid}/task/${process.pid}/children`,
        "utf-8",
      ),
    );
    return listed.isOk()
      ? listed.value.trim().split(/\s+/u).filter(Boolean)
      : [];
  }
  const listed = Bun.spawnSync(["pgrep", "-P", String(process.pid)]);
  return listed.stdout.toString().trim().split(/\s+/u).filter(Boolean);
};

// Linux keeps each process's high-water mark (VmHWM); elsewhere only the
// current size can be read, so a sample taken before the child exits.
const residentKiB = (pid: string): number => {
  if (process.platform === "linux") {
    const status = Result.try(() =>
      readFileSync(`/proc/${pid}/status`, "utf-8"),
    );
    const peak = status.isOk()
      ? /^VmHWM:\s+(\d+) kB$/mu.exec(status.value)?.[1]
      : undefined;
    return peak === undefined ? 0 : Number(peak);
  }
  const sampled = Bun.spawnSync(["ps", "-o", "rss=", "-p", pid]);
  const resident = Number(sampled.stdout.toString().trim());
  return Number.isFinite(resident) ? resident : 0;
};

/** The largest child's peak resident memory in MiB (0 without children). */
export const childPeakRssMiB = (): number =>
  Math.round(Math.max(0, ...childPids().map(residentKiB)) / MIB);
