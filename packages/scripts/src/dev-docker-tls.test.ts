import { Result } from "better-result";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  dockerCommand,
  DockerEndpointError,
  resolveDockerTarget,
} from "./dev-docker";

const files = ["ca.pem", "cert.pem", "key.pem"] as const;

test("a captured Docker transport retains its endpoint and credential bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "docker-transport-"));
  const original = {
    host: "tcp://original.example:2376",
    name: "original",
    credentials: path.join(root, "contexts", "docker"),
  };
  const replacement = {
    host: "tcp://replacement.example:2376",
    name: "replacement",
    credentials: path.join(root, "replacement", "docker"),
  };
  let selected = original;
  let inspections = 0;
  let probes = 0;
  const inspect = () => {
    inspections++;
    return Result.ok(
      JSON.stringify({
        Name: "selected",
        Endpoints: { docker: { Host: selected.host, SkipTLSVerify: false } },
        TLSMaterial: { docker: files },
        Storage: { TLSPath: path.dirname(selected.credentials) },
      }),
    );
  };
  // Model CLI selector resolution and daemon credential verification separately.
  const execute = (cmd: string[], env: NodeJS.ProcessEnv) => {
    const selector = cmd.at(1);
    if (selector !== "--context" && selector !== "--host") {
      return { status: "rejected" };
    }
    const host = selector === "--context" ? selected.host : cmd.at(2);
    const certificates =
      selector === "--context" ? selected.credentials : env["DOCKER_CERT_PATH"];
    const daemon = [original, replacement].find(
      (candidate) => candidate.host === host,
    );
    if (!daemon || !certificates || !env["DOCKER_TLS_VERIFY"]) {
      return { status: "rejected" };
    }
    const verified = files.every(
      (file) =>
        existsSync(path.join(certificates, file)) &&
        readFileSync(path.join(certificates, file), "utf-8") ===
          `${daemon.name}:${file}\n`,
    );
    return verified
      ? { status: "connected", daemon: daemon.name }
      : { status: "rejected" };
  };
  try {
    for (const daemon of [original, replacement]) {
      mkdirSync(daemon.credentials, { recursive: true });
      for (const file of files) {
        writeFileSync(
          path.join(daemon.credentials, file),
          `${daemon.name}:${file}\n`,
        );
      }
    }
    const resolved = resolveDockerTarget({
      env: {
        DOCKER_CONTEXT: "selected",
        DOCKER_CERT_PATH: "/unrelated",
        DOCKER_TLS_VERIFY: "1",
      },
      inspect,
      tlsDefaults: () => {
        probes++;
        return Result.err(
          new DockerEndpointError({
            message: "Named contexts do not use default certificates.",
          }),
        );
      },
    });
    expect(
      resolved.isOk(),
      resolved.isErr() ? resolved.error.message : "",
    ).toBe(true);
    if (resolved.isErr()) {
      return;
    }
    using target = resolved.value;
    const snapshot = target.env["DOCKER_CERT_PATH"];
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      return;
    }
    expect(String(target.host)).toBe(original.host);
    const command = dockerCommand(target, ["version"]);
    expect(execute(command.cmd, command.env)).toEqual({
      status: "connected",
      daemon: "original",
    });
    if (process.platform !== "win32") {
      expect(statSync(snapshot).mode % 0o1000).toBe(0o700);
      for (const file of files) {
        expect(statSync(path.join(snapshot, file)).mode % 0o1000).toBe(0o600);
      }
    }
    // Update the named context's endpoint and overwrite its registered material.
    selected = replacement;
    for (const file of files) {
      writeFileSync(
        path.join(original.credentials, file),
        readFileSync(path.join(replacement.credentials, file)),
      );
    }
    expect(
      execute(["docker", "--context", "selected", "version"], {
        DOCKER_TLS_VERIFY: "1",
      }),
    ).toEqual({ status: "connected", daemon: "replacement" });
    // Each daemon authenticates its own immutable credential identity.
    expect(execute(command.cmd, command.env)).toEqual({
      status: "connected",
      daemon: "original",
    });
    expect(inspections).toBe(1);
    expect(probes).toBe(0);

    const defaults = path.join(root, "credentials");
    mkdirSync(defaults);
    for (const file of files) {
      writeFileSync(path.join(defaults, file), `original:${file}\n`);
    }
    const defaultResolved = resolveDockerTarget({
      cwd: root,
      env: {
        DOCKER_CONFIG: "config",
        DOCKER_HOST: original.host,
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "credentials",
      },
      inspect: (env) =>
        Result.ok(
          JSON.stringify({
            Name: "default",
            Endpoints: { docker: { Host: env["DOCKER_HOST"] } },
          }),
        ),
      tlsDefaults: (env) => {
        probes++;
        expect(env["DOCKER_CONFIG"]).toBe(path.join(root, "config"));
        expect(env["DOCKER_CERT_PATH"]).toBe(defaults);
        return Result.ok(defaults);
      },
    });
    expect(
      defaultResolved.isOk(),
      defaultResolved.isErr() ? defaultResolved.error.message : "",
    ).toBe(true);
    if (defaultResolved.isErr()) {
      return;
    }
    using defaultTarget = defaultResolved.value;
    const defaultCommand = dockerCommand(defaultTarget, ["version"]);
    expect(execute(defaultCommand.cmd, defaultCommand.env)).toEqual({
      status: "connected",
      daemon: "original",
    });
    expect(probes).toBe(1);
    target[Symbol.dispose]();
    expect(existsSync(snapshot)).toBe(false);
    target[Symbol.dispose]();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TLS defaults discovery failures are returned before execution", () => {
  const failure = new DockerEndpointError({
    message: "Certificate defaults are unavailable.",
  });
  const result = resolveDockerTarget({
    env: { DOCKER_TLS_VERIFY: "1" },
    inspect: () =>
      Result.ok(
        JSON.stringify({
          Name: "default",
          Endpoints: { docker: { Host: "tcp://example.test:2376" } },
        }),
      ),
    tlsDefaults: () => Result.err(failure),
  });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    return;
  }
  expect(result.error).toBe(failure);
});
