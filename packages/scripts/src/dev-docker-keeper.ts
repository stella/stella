import { Result, TaggedError } from "better-result";

import { dockerCommand, type DockerTarget } from "./dev-docker";

const KEEPER_READY_TIMEOUT_MS = 120_000;
const KEEPER_POLL_MS = 1000;

class DockerKeeperError extends TaggedError("DockerKeeperError")<{
  message: string;
  cause?: unknown;
}> {}

type EnsureDockerKeeperOptions = {
  label: string;
  dockerTarget: DockerTarget;
  run: (command: string[]) => boolean;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

export const ensureDockerKeeper = async ({
  label,
  dockerTarget,
  run,
  now,
  sleep,
}: EnsureDockerKeeperOptions) => {
  if (!/^[A-Za-z0-9_.-]+$/u.test(label)) {
    return Result.err(
      new DockerKeeperError({ message: "Invalid Docker keeper label." }),
    );
  }
  const execute = (command: string[]) =>
    Result.try({
      try: () => run(command),
      catch: (cause) =>
        new DockerKeeperError({
          message: "Docker keeper command failed.",
          cause,
        }),
    });
  const initial = execute(dockerCommand(dockerTarget, ["info"]).cmd);
  if (initial.isErr()) {
    return initial;
  }
  if (initial.value) {
    return Result.ok(undefined);
  }
  const target = `system/${label}`;
  // No -k: a keeper may already be recovering a protected runtime.
  const started = execute(["launchctl", "kickstart", target]);
  if (started.isErr()) {
    return started;
  }
  if (!started.value) {
    return Result.err(
      new DockerKeeperError({
        message: `Cannot start Docker keeper ${label}.`,
      }),
    );
  }
  const deadline = now() + KEEPER_READY_TIMEOUT_MS;
  while (now() < deadline) {
    const ready = execute(dockerCommand(dockerTarget, ["info"]).cmd);
    if (ready.isErr()) {
      return ready;
    }
    if (ready.value) {
      return Result.ok(undefined);
    }
    const waited = await Result.tryPromise({
      try: async () => sleep(KEEPER_POLL_MS),
      catch: (cause) =>
        new DockerKeeperError({ message: "Docker keeper wait failed.", cause }),
    });
    if (waited.isErr()) {
      return waited;
    }
  }
  return Result.err(
    new DockerKeeperError({
      message: `Docker keeper ${label} did not recover Docker within 120 seconds.`,
    }),
  );
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
