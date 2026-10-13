import { Result } from "better-result";
import path from "node:path";

import {
  DockerEndpointError,
  resolveDockerTarget,
  resolveInstalledDevDockerKeeper,
} from "./dev-docker";

const configurePostgres = () => {
  const [container, owner, database = "stella", host] = process.argv.slice(2);
  if (!container || !owner) {
    throw new DockerEndpointError({
      message: "Postgres container and owner arguments are required.",
    });
  }
  const env = { ...process.env };
  if (host) {
    env["DOCKER_HOST"] = host;
    delete env["DOCKER_CONTEXT"];
  }
  using target = resolveDockerTarget({ env }).unwrap(
    "Postgres Docker target preparation failed",
  );
  resolveInstalledDevDockerKeeper(target).unwrap(
    "Postgres Docker target validation failed",
  );
  const child = Bun.spawnSync(
    [
      "bash",
      path.resolve(
        import.meta.dir,
        "../../../scripts/configure-test-postgres.sh",
      ),
      container,
      owner,
      database,
      target.host,
      "captured",
    ],
    { env: target.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  return child.exitCode;
};

if (import.meta.main) {
  const configured = Result.try({
    try: configurePostgres,
    catch: (cause) =>
      new DockerEndpointError({
        message: "Postgres Docker configuration failed.",
        cause,
      }),
  });
  if (configured.isErr()) {
    process.stderr.write(
      `${configured.error.message} ${String(configured.error.cause)}\n`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = configured.value;
  }
}
