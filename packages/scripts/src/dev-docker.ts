import { Result, TaggedError } from "better-result";
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

class DockerEndpointError extends TaggedError("DockerEndpointError")<{
  message: string;
  cause?: unknown;
}> {}

const validateDockerHost = (value: string) => {
  const parsed = v.safeParse(dockerHostSchema, value);
  if (!parsed.success) {
    throw new DockerEndpointError({
      message: "Docker context did not resolve a valid endpoint.",
    });
  }
  return parsed.output;
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

const inspectDockerEndpoint = (env: NodeJS.ProcessEnv) => {
  const result = Result.try(() =>
    Bun.spawnSync(DOCKER_ENDPOINT_COMMAND, {
      cwd: "/",
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    }),
  );
  if (result.isErr()) {
    throw new DockerEndpointError({
      message: "Could not inspect the Docker endpoint.",
      cause: result.error,
    });
  }
  if (!result.value.success) {
    throw new DockerEndpointError({
      message: "Docker endpoint discovery failed.",
      cause: result.value.stderr.toString(),
    });
  }
  return result.value.stdout.toString();
};

type ResolveDockerTargetOptions = {
  env: NodeJS.ProcessEnv;
  inspect?: typeof inspectDockerEndpoint;
};

export const resolveDockerTarget = ({
  env,
  inspect = inspectDockerEndpoint,
}: ResolveDockerTargetOptions) => {
  const captured = { ...env };
  const host = validateDockerHost(inspect(captured).replace(/\n$/u, ""));
  return Object.freeze({
    host,
    env: Object.freeze(dockerEnvironment(captured)),
  });
};

export type DockerTarget = ReturnType<typeof resolveDockerTarget>;

export const dockerCommand = (
  target: DockerTarget,
  args: readonly string[],
) => ({
  cmd: ["docker", "--host", target.host, ...args],
  env: target.env,
});
