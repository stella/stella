import { type InferOk, panic, Result, TaggedError } from "better-result";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

const validateDockerHost = (
  value: string,
): Result<v.InferOutput<typeof dockerHostSchema>, DockerEndpointError> => {
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
  "{{json .}}",
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
  cwd?: string;
  inspect?: typeof inspectDockerEndpoint;
  tlsDefaults?: typeof defaultCertificatePath;
};

const TLS_FILES = ["ca.pem", "cert.pem", "key.pem"] as const;

const dockerInspectionSchema = v.object({
  Name: v.pipe(
    v.string(),
    v.minLength(1),
    v.check((name) => name === name.trim() && !/[\r\n\0]/u.test(name)),
  ),
  Endpoints: v.object({
    docker: v.object({
      Host: v.string(),
      SkipTLSVerify: v.optional(v.boolean(), false),
    }),
  }),
  TLSMaterial: v.optional(
    v.object({
      docker: v.optional(v.array(v.picklist(TLS_FILES)), []),
    }),
  ),
  Storage: v.optional(v.object({ TLSPath: v.string() })),
});

const parseDockerInspection = (output: string) =>
  Result.try({
    try: (): unknown => JSON.parse(output),
    catch: (cause) =>
      new DockerEndpointError({
        message: "Docker endpoint discovery returned invalid metadata.",
        cause,
      }),
  }).andThen((metadata) => {
    const parsed = v.safeParse(dockerInspectionSchema, metadata);
    if (!parsed.success) {
      return Result.err(
        new DockerEndpointError({
          message: "Docker endpoint discovery returned invalid metadata.",
        }),
      );
    }
    return validateDockerHost(parsed.output.Endpoints.docker.Host).map(
      (host) => ({
        host,
        context: parsed.output.Name,
        skipTLSVerify: parsed.output.Endpoints.docker.SkipTLSVerify,
        material: parsed.output.TLSMaterial?.docker ?? [],
        tlsPath: parsed.output.Storage?.TLSPath,
      }),
    );
  });

type DockerInspection = InferOk<ReturnType<typeof parseDockerInspection>>;
// Docker's own default option paths are resolved from the captured environment.
const defaultCertificatePath = (
  env: NodeJS.ProcessEnv,
): Result<string, DockerEndpointError> => {
  // Help must resolve filesystem defaults without initializing a live transport.
  const helpEnv = dockerEnvironment(env);
  delete helpEnv["DOCKER_TLS"];
  delete helpEnv["DOCKER_TLS_VERIFY"];
  return Result.try({
    try: () =>
      Bun.spawnSync(["docker", "--context", "default", "--help"], {
        cwd: "/",
        env: helpEnv,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      }),
    catch: (cause) =>
      new DockerEndpointError({
        message: "Could not inspect Docker's TLS certificate defaults.",
        cause,
      }),
  }).andThen((result) => {
    if (!result.success) {
      return Result.err(
        new DockerEndpointError({
          message: "Could not inspect Docker's TLS certificate defaults.",
          cause: {
            exitCode: result.exitCode,
            stderr: result.stderr.toString(),
          },
        }),
      );
    }
    const lines = result.stdout.toString().split("\n");
    const start = lines.findIndex((line) =>
      line.trimStart().startsWith("--tlscacert "),
    );
    const block: string[] = [];
    for (let index = start; index >= 0 && index < lines.length; index += 1) {
      const line = lines.at(index);
      if (
        line === undefined ||
        (index !== start && line.trimStart().startsWith("-"))
      ) {
        break;
      }
      block.push(line);
    }
    const option = block.join("\n");
    const marker = "(default";
    const position = option.indexOf(marker);
    const value =
      position === -1 ? "" : option.slice(position + marker.length).trim();
    const encoded = value.endsWith(")") ? value.slice(0, -1) : undefined;
    if (!encoded) {
      return Result.err(
        new DockerEndpointError({
          message: "Docker did not report its TLS certificate defaults.",
        }),
      );
    }
    return Result.try({
      try: (): unknown => JSON.parse(encoded),
      catch: (cause) =>
        new DockerEndpointError({
          message: "Docker reported invalid TLS certificate defaults.",
          cause,
        }),
    }).andThen((filename) => {
      if (
        typeof filename !== "string" ||
        !path.isAbsolute(filename) ||
        path.basename(filename) !== "ca.pem"
      ) {
        return Result.err(
          new DockerEndpointError({
            message: "Docker reported invalid TLS certificate defaults.",
          }),
        );
      }
      return Result.ok(path.dirname(filename));
    });
  });
};

type SnapshotDockerTargetOptions = {
  inspection: DockerInspection;
  env: NodeJS.ProcessEnv;
  tlsDefaults: typeof defaultCertificatePath;
};
type DockerTLSSettings =
  { type: "plain" } | { type: "tls"; source: string | undefined };
const dockerTLSSettings = ({
  inspection,
  env,
  tlsDefaults,
}: SnapshotDockerTargetOptions): Result<
  DockerTLSSettings,
  DockerEndpointError
> => {
  if (inspection.context === "default") {
    return env["DOCKER_TLS"] || env["DOCKER_TLS_VERIFY"]
      ? tlsDefaults(env).map((source) => ({
          type: "tls" as const,
          source,
        }))
      : Result.ok({ type: "plain" });
  }
  if (inspection.material.length === 0 && !inspection.skipTLSVerify) {
    return Result.ok({ type: "plain" });
  }
  const source = inspection.tlsPath && path.join(inspection.tlsPath, "docker");
  if ((!source || !path.isAbsolute(source)) && inspection.material.length > 0) {
    return Result.err(
      new DockerEndpointError({
        message: "Docker TLS material has no storage path.",
      }),
    );
  }
  return Result.ok({ type: "tls", source });
};

const snapshotDockerTarget = ({
  inspection,
  env,
  tlsDefaults,
}: SnapshotDockerTargetOptions) =>
  dockerTLSSettings({ inspection, env, tlsDefaults }).andThen((tls) => {
    let snapshot: string | undefined;
    return Result.try({
      try: () => {
        const executionEnv = dockerEnvironment(env);
        const namedContext = inspection.context !== "default";
        if (namedContext) {
          delete executionEnv["DOCKER_TLS"];
          delete executionEnv["DOCKER_TLS_VERIFY"];
          delete executionEnv["DOCKER_CERT_PATH"];
          if (tls.type === "tls") {
            executionEnv["DOCKER_TLS"] = "1";
            if (!inspection.skipTLSVerify) {
              executionEnv["DOCKER_TLS_VERIFY"] = "1";
            }
          }
        }
        if (tls.type === "tls") {
          const { source } = tls;
          const files = TLS_FILES.flatMap((name) => {
            const registered = namedContext
              ? inspection.material.includes(name)
              : source && existsSync(path.join(source, name));
            return registered && source
              ? [{ name, bytes: readFileSync(path.join(source, name)) }]
              : [];
          });
          snapshot = mkdtempSync(path.join(tmpdir(), "stella-docker-tls-"));
          for (const { name, bytes } of files) {
            writeFileSync(path.join(snapshot, name), bytes, {
              mode: 0o600,
              flag: "wx",
            });
          }
          executionEnv["DOCKER_CERT_PATH"] = snapshot;
        }
        const close = (): Result<void, DockerEndpointError> => {
          if (snapshot === undefined) {
            return Result.ok(undefined);
          }
          const directory = snapshot;
          return Result.try({
            try: () => rmSync(directory, { recursive: true, force: true }),
            catch: (cause) =>
              new DockerEndpointError({
                message: "Could not remove Docker TLS snapshot.",
                cause,
              }),
          }).tap(() => {
            snapshot = undefined;
            process.removeListener("exit", onExit);
          });
        };
        const reportCleanupFailure = () => {
          const removed = close();
          if (removed.isErr()) {
            process.stderr.write(
              `${removed.error.message} ${String(removed.error.cause)}\n`,
            );
            process.exitCode = 1;
          }
        };
        const onExit = reportCleanupFailure;
        if (snapshot !== undefined) {
          process.once("exit", onExit);
        }
        return Object.freeze({
          host: inspection.host,
          env: Object.freeze(executionEnv),
          close,
          // The disposal protocol cannot return an error to its caller. Owners consume
          // close() explicitly; this fallback reports failures and sets a failing status.
          [Symbol.dispose]: reportCleanupFailure,
        });
      },
      catch: (cause) => {
        const removed = Result.try({
          try: () => {
            if (snapshot !== undefined) {
              rmSync(snapshot, { recursive: true, force: true });
            }
          },
          catch: (cleanup) => cleanup,
        });
        return new DockerEndpointError({
          message: "Could not snapshot Docker transport settings.",
          cause: removed.isErr()
            ? { snapshot: cause, cleanup: removed.error }
            : cause,
        });
      },
    });
  });

export const resolveDockerTarget = ({
  env,
  cwd = process.cwd(),
  inspect = inspectDockerEndpoint,
  tlsDefaults = defaultCertificatePath,
}: ResolveDockerTargetOptions) => {
  const captured = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value && ["DOCKER_CONFIG", "DOCKER_CERT_PATH"].includes(key)
        ? path.resolve(cwd, value)
        : value,
    ]),
  );
  return inspect(captured)
    .andThen(parseDockerInspection)
    .andThen((inspection) =>
      snapshotDockerTarget({ inspection, env: captured, tlsDefaults }),
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
  target: Pick<DockerTarget, "host" | "env">;
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

export const resolveInstalledDevDockerKeeper = (
  target: Pick<DockerTarget, "host" | "env">,
) =>
  resolveDevDockerKeeper({
    target,
    resolver: Bun.which("docker-keeper", { PATH: target.env["PATH"] ?? "" }),
    configuredLabel: target.env["STELLA_DOCKER_KEEPER_LABEL"],
    run: (command, env) =>
      Result.try({
        try: () =>
          Bun.spawnSync(command, {
            cwd: "/",
            env,
            stdout: "pipe",
            stderr: "pipe",
            timeout: 5000,
          }),
        catch: (cause) =>
          new DockerEndpointError({
            message: "Could not validate the development Docker endpoint.",
            cause,
          }),
      }).andThen((result) =>
        result.success
          ? Result.ok(result.stdout.toString())
          : Result.err(
              new DockerEndpointError({
                message:
                  "Selected Docker endpoint cannot be used for development. Select an unprotected Docker context.",
                cause: result.stderr.toString(),
              }),
            ),
      ),
  });

export const validateCapturedDevDockerHost = (
  host: string,
  env: NodeJS.ProcessEnv,
) =>
  validateDockerHost(host).andThen((validatedHost) =>
    resolveInstalledDevDockerKeeper({
      host: validatedHost,
      env: dockerEnvironment(env),
    }),
  );
