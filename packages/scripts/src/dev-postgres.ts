import { Result } from "better-result";
import path from "node:path";

import {
  DockerEndpointError,
  resolveDockerTarget,
  resolveInstalledDevDockerKeeper,
  validateCapturedDevDockerHost,
} from "./dev-docker";

const configurePostgres = (): Result<number, DockerEndpointError> => {
  const [container, owner, database = "stella", host] = process.argv.slice(2);
  if (container === "--validate-captured-host" && owner) {
    return validateCapturedDevDockerHost(owner, process.env).map(() => 0);
  }
  if (!container || !owner) {
    return Result.err(
      new DockerEndpointError({
        message: "Postgres container and owner arguments are required.",
      }),
    );
  }
  const env = { ...process.env };
  if (host) {
    env["DOCKER_HOST"] = host;
    delete env["DOCKER_CONTEXT"];
  }
  return resolveDockerTarget({ env }).andThen((target) => {
    using lifetime = target;
    const configured = resolveInstalledDevDockerKeeper(lifetime).andThen(() =>
      Result.try({
        try: () =>
          Bun.spawnSync(
            [
              "bash",
              path.resolve(
                import.meta.dir,
                "../../../scripts/configure-test-postgres.sh",
              ),
              container,
              owner,
              database,
              lifetime.host,
              "captured",
            ],
            {
              env: lifetime.env,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            },
          ).exitCode,
        catch: (cause) =>
          new DockerEndpointError({
            message: "Postgres Docker configuration failed.",
            cause,
          }),
      }),
    );
    const closed = lifetime.close();
    if (closed.isErr()) {
      return Result.err(
        new DockerEndpointError({
          message: configured.isErr()
            ? `${configured.error.message}; ${closed.error.message}`
            : closed.error.message,
          cause: { operation: configured, cleanup: closed.error },
        }),
      );
    }
    return configured;
  });
};

if (import.meta.main) {
  const configured = Result.try({
    try: configurePostgres,
    catch: (cause) =>
      new DockerEndpointError({
        message: "Postgres Docker configuration failed.",
        cause,
      }),
  }).andThen((result) => result);
  if (configured.isErr()) {
    process.stderr.write(
      `${configured.error.message} ${String(configured.error.cause)}\n`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = configured.value;
  }
}
