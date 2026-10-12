import { TaggedError } from "better-result";

const KEEPER_READY_TIMEOUT_MS = 120_000;
const KEEPER_POLL_MS = 1000;

class DockerKeeperError extends TaggedError("DockerKeeperError")<{
  message: string;
}> {}

type EnsureDockerKeeperOptions = {
  label: string;
  run: (command: string[]) => boolean;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

export const ensureDockerKeeper = async ({
  label,
  run,
  now,
  sleep,
}: EnsureDockerKeeperOptions) => {
  if (!/^[A-Za-z0-9_.-]+$/u.test(label)) {
    throw new DockerKeeperError({ message: "Invalid Docker keeper label." });
  }
  if (run(["docker", "info"])) {
    return;
  }
  const target = `system/${label}`;
  // No -k: a keeper may already be recovering a protected runtime.
  if (!run(["launchctl", "kickstart", target])) {
    throw new DockerKeeperError({
      message: `Cannot start Docker keeper ${label}.`,
    });
  }
  const deadline = now() + KEEPER_READY_TIMEOUT_MS;
  while (now() < deadline) {
    if (run(["docker", "info"])) {
      return;
    }
    await sleep(KEEPER_POLL_MS);
  }
  throw new DockerKeeperError({
    message: `Docker keeper ${label} did not recover Docker within 120 seconds.`,
  });
};

type DockerKeeperCommandOptions = {
  command: string[];
  platform: string;
  uid: number | undefined;
};

export const dockerKeeperCommand = ({
  command,
  platform,
  uid,
}: DockerKeeperCommandOptions) => ({
  command:
    platform === "darwin" && uid !== 0 && command.at(0) === "launchctl"
      ? ["sudo", "-n", "--", ...command]
      : command,
  cwd: "/",
});
