import { type InferOk, panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

const dockerHostSchema = v.pipe(
  v.string(),
  v.check((value) => {
    if (
      value !== value.trim() ||
      /[\r\n\0]/u.test(value) ||
      !URL.canParse(value)
    ) {
      return false;
    }
    const endpoint = new URL(value);
    switch (endpoint.protocol) {
      case "unix:":
        return (
          value.startsWith("unix:///") &&
          endpoint.hostname === "" &&
          endpoint.pathname.length > 1
        );
      case "npipe:":
        return endpoint.pathname.length > 1;
      case "tcp:":
      case "ssh:":
        return endpoint.hostname.length > 0;
      default:
        return false;
    }
  }),
  v.brand("DockerHost"),
);

export class DockerEndpointError extends TaggedError("DockerEndpointError")<{
  message: string;
  cause?: unknown;
}> {}

const validateDockerHost = (value: string) => {
  const parsed = v.safeParse(dockerHostSchema, value);
  if (!parsed.success) {
    return Result.err(
      new DockerEndpointError({
        message: "Docker context did not resolve a valid endpoint.",
      }),
    );
  }
  return Result.ok(parsed.output);
};

const dockerEnvironment = (base: NodeJS.ProcessEnv) => {
  const env = { ...base };
  delete env["DOCKER_HOST"];
  delete env["DOCKER_CONTEXT"];
  return env;
};

const DOCKER_ENDPOINT_COMMAND = [
  "docker",
  "context",
  "inspect",
  "--format",
  "{{.Endpoints.docker.Host}}",
];

const inspectDockerEndpoint = (env: NodeJS.ProcessEnv) =>
  Result.try({
    try: () =>
      Bun.spawnSync(DOCKER_ENDPOINT_COMMAND, {
        cwd: "/",
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      }),
    catch: (cause) =>
      new DockerEndpointError({
        message: "Could not inspect the Docker endpoint.",
        cause,
      }),
  }).andThen((result) =>
    result.success
      ? Result.ok(result.stdout.toString())
      : Result.err(
          new DockerEndpointError({
            message: "Docker endpoint discovery failed.",
            cause: result.stderr.toString(),
          }),
        ),
  );

type ResolveDockerTargetOptions = {
  env: NodeJS.ProcessEnv;
  inspect?: typeof inspectDockerEndpoint;
};

export const resolveDockerTarget = ({
  env,
  inspect = inspectDockerEndpoint,
}: ResolveDockerTargetOptions) => {
  const captured = { ...env };
  return inspect(captured)
    .andThen((output) => validateDockerHost(output.replace(/\n$/u, "")))
    .map((host) =>
      Object.freeze({ host, env: Object.freeze(dockerEnvironment(captured)) }),
    );
};

export type DockerTarget = InferOk<ReturnType<typeof resolveDockerTarget>>;

export type DockerCommandArguments =
  | readonly ["compose", ...string[]]
  | readonly ["info", ...string[]]
  | readonly ["ps", ...string[]]
  | readonly ["version", ...string[]]
  | readonly ["volume", "ls", ...string[]];

const COMPOSE_VALUE_OPTIONS = new Set([
  "--project-name",
  "--file",
  "--profile",
]);
const composeAction = (args: readonly string[]) => {
  let index = 1;
  while (COMPOSE_VALUE_OPTIONS.has(args.at(index) ?? "")) {
    index += 2;
  }
  return args.at(index);
};

const DOCKER_COMMAND_POLICY = {
  compose: (args) => ["up", "down", "ps"].includes(composeAction(args) ?? ""),
  info: (_args) => true,
  ps: (_args) => true,
  version: (_args) => true,
  volume: (args) => args.at(1) === "ls",
} satisfies Record<
  DockerCommandArguments[0],
  (args: readonly string[]) => boolean
>;

const hasDockerPolicy = (
  command: string | undefined,
): command is keyof typeof DOCKER_COMMAND_POLICY =>
  command !== undefined && Object.hasOwn(DOCKER_COMMAND_POLICY, command);

const assertDockerCommand = (args: readonly string[]) => {
  const command = args.at(0);
  const valueOptions = new Set([
    "--format",
    "--filter",
    ...COMPOSE_VALUE_OPTIONS,
  ]);
  let unsafeOption = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args.at(index) ?? "";
    if (valueOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (
      /^(?:--(?:host|context|config|mount|volume|volume-driver|device)(?:=|$))/u.test(
        arg,
      )
    ) {
      unsafeOption = true;
      break;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      for (let offset = 1; offset < arg.length; offset += 1) {
        const flag = arg.charAt(offset);
        if (["H", "c", "v"].includes(flag)) {
          unsafeOption = true;
          break;
        }
        if (["f", "n", "p"].includes(flag)) {
          if (offset === arg.length - 1) {
            index += 1;
          }
          break;
        }
      }
    }
  }
  if (
    !hasDockerPolicy(command) ||
    !DOCKER_COMMAND_POLICY[command](args) ||
    unsafeOption
  ) {
    panic(
      "Development Docker command is outside the pinned, mount-safe command policy.",
    );
  }
};

export const dockerCommand = (
  target: DockerTarget,
  args: DockerCommandArguments,
) => {
  assertDockerCommand(args);
  return {
    cmd: ["docker", "--host", target.host, ...args],
    env: target.env,
  };
};

type ResolveDevDockerKeeperOptions = {
  target: DockerTarget;
  resolver: string | null;
  configuredLabel: string | undefined;
  run: (
    command: string[],
    env: NodeJS.ProcessEnv,
  ) => Result<string, DockerEndpointError>;
};

export const resolveDevDockerKeeper = ({
  target,
  resolver,
  configuredLabel,
  run,
}: ResolveDevDockerKeeperOptions) => {
  const colimaSocket =
    target.host.startsWith("unix:///") &&
    new URL(target.host).pathname.split("/").includes(".colima");
  if (!resolver && (configuredLabel || colimaSocket)) {
    return Result.err(
      new DockerEndpointError({
        message:
          "A keeper resolver is required to validate a Colima endpoint or configured development keeper.",
      }),
    );
  }
  const checked = resolver
    ? run(
        [
          resolver,
          "--purpose",
          "dev",
          "--host",
          target.host,
          ...(configuredLabel ? ["--keeper-label", configuredLabel] : []),
        ],
        target.env,
      )
    : Result.ok("");
  if (checked.isErr()) {
    return Result.err(checked.error);
  }
  return Result.ok(checked.value.trim() || configuredLabel);
};
