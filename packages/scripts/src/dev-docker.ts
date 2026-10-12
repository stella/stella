import { type InferOk, Result, TaggedError } from "better-result";
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

export const dockerCommand = (
  target: DockerTarget,
  args: readonly string[],
) => ({
  cmd: ["docker", "--host", target.host, ...args],
  env: target.env,
});

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
