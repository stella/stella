import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  dockerCommand,
  DockerEndpointError,
  resolveDevDockerKeeper,
  resolveDockerTarget,
} from "./dev-docker";

const dockerInspection = (host: string, context = "default") =>
  JSON.stringify({ Name: context, Endpoints: { docker: { Host: host } } });

test("endpoint resolution preserves the supplied selectors, then pins a captured environment", () => {
  const env = {
    DOCKER_CONTEXT: "chosen",
    DOCKER_HOST: "unix:///tmp/other.sock",
    PATH: "/tools",
    DOCKER_CONFIG: "/configuration",
  };
  const inspections: NodeJS.ProcessEnv[] = [];
  const target = resolveDockerTarget({
    env,
    inspect: (captured) => {
      inspections.push(captured);
      return Result.ok(dockerInspection("unix:///tmp/chosen.sock", "chosen"));
    },
  }).unwrap();
  expect(inspections).toEqual([env]);
  env.DOCKER_CONTEXT = "changed";
  env.DOCKER_HOST = "unix:///tmp/changed.sock";
  env.PATH = "/changed";
  expect(dockerCommand(target, ["compose", "down"])).toEqual({
    cmd: ["docker", "--host", "unix:///tmp/chosen.sock", "compose", "down"],
    env: { PATH: "/tools", DOCKER_CONFIG: "/configuration" },
  });
});

test.each([
  "unix:///tmp/docker.sock",
  "tcp://localhost:2375",
  "ssh://user@host",
  "npipe:////./pipe/docker_engine",
])("accepts supported Docker endpoint transport %s", (host) => {
  expect(
    String(
      resolveDockerTarget({
        env: {},
        inspect: () => Result.ok(dockerInspection(host)),
      }).unwrap().host,
    ),
  ).toBe(host);
});

test.each([
  "",
  "--context selected",
  "https://host",
  "unix:///",
  "unix://./docker.sock",
  "unix:docker.sock",
  "unix://host/docker.sock",
  "unix:///tmp/socket \n",
  "unix:///tmp/socket\r\n",
  "tcp:///",
  "unix:///tmp/a.sock\nunix:///tmp/b.sock",
])("refuses an invalid or ambiguous Docker endpoint %s", (host) => {
  expect(
    resolveDockerTarget({
      env: {},
      inspect: () => Result.ok(dockerInspection(host)),
    }),
  ).toMatchObject({
    error: { message: expect.stringContaining("valid endpoint") },
  });
});

test("a named plain context retains ordinary environment and ignores ambient TLS settings", () => {
  const env = {
    DOCKER_HOST: "tcp://other:2376",
    DOCKER_CONTEXT: "other",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/certificates",
    PATH: "/tools",
  };
  using target = resolveDockerTarget({
    env,
    inspect: () =>
      Result.ok(dockerInspection("unix:///tmp/test.sock", "selected")),
  }).unwrap();
  expect(target.env).toEqual({ PATH: "/tools" });
  expect(env.DOCKER_CONTEXT).toBe("other");
});

test.skipIf(process.platform === "win32" || !Bun.which("docker"))(
  "installed Docker CLI resolution matches the daemon it actually contacts across selector combinations",
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "dk-"));
    const config = path.join(root, "config");
    const base = {
      PATH: process.env["PATH"],
      HOME: root,
      DOCKER_CONFIG: config,
    };
    const servers = ["persisted", "selected", "override"].map((name) => {
      const socket = path.join(root, `${name}.sock`);
      return {
        name,
        host: `unix://${socket}`,
        server: Bun.serve({
          unix: socket,
          fetch: (request) => {
            const url = new URL(request.url);
            const headers = { "API-Version": "1.54" };
            if (url.pathname.endsWith("/_ping")) {
              return new Response("OK", { headers });
            }
            return Response.json(
              {
                Version: name,
                ApiVersion: "1.54",
                MinAPIVersion: "1.24",
                GitCommit: "fixture",
                GoVersion: "fixture",
                Os: "linux",
                Arch: "arm64",
                KernelVersion: "fixture",
              },
              { headers },
            );
          },
        }),
      };
    });
    const run = async (args: string[], env: NodeJS.ProcessEnv) => {
      const child = Bun.spawn(["docker", ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout: stdout.trim(), stderr, exitCode };
    };
    try {
      for (const server of servers) {
        const created = await run(
          ["context", "create", server.name, "--docker", `host=${server.host}`],
          base,
        );
        expect(created.exitCode, created.stderr).toBe(0);
      }
      const persisted = servers.find((server) => server.name === "persisted");
      const selected = servers.find((server) => server.name === "selected");
      const override = servers.find((server) => server.name === "override");
      expect(persisted).toBeDefined();
      expect(selected).toBeDefined();
      expect(override).toBeDefined();
      if (!persisted || !selected || !override) {
        panic("Missing daemon fixture");
      }
      const used = await run(["context", "use", persisted.name], base);
      expect(used.exitCode, used.stderr).toBe(0);
      const version = await run(["--version"], base);
      for (const selectors of [
        {},
        { DOCKER_CONTEXT: "", DOCKER_HOST: "" },
        { DOCKER_HOST: override.host },
        { DOCKER_CONTEXT: selected.name },
        { DOCKER_HOST: override.host, DOCKER_CONTEXT: selected.name },
        { DOCKER_HOST: override.host, DOCKER_CONTEXT: "missing" },
        { DOCKER_CONTEXT: "missing" },
      ]) {
        const env = { ...base, ...selectors };
        const receipt = await run(
          ["context", "inspect", "--format", "{{.Name}}"],
          env,
        );
        const resolved = resolveDockerTarget({ env });
        const ambient = await run(
          ["version", "--format", "{{.Server.Version}}"],
          env,
        );
        expect(resolved.isOk(), version.stdout).toBe(ambient.exitCode === 0);
        if (resolved.isErr()) {
          continue;
        }
        const target = resolved.value;
        expect(
          servers.find((server) => server.name === ambient.stdout)?.host,
          version.stdout,
        ).toBe(target.host);
        const redirect =
          servers.find((server) => server.host !== target.host) ??
          panic("Missing alternate daemon fixture");
        const selectedContext = receipt.stdout;
        if (selectedContext !== "default") {
          const updated = await run(
            [
              "context",
              "update",
              selectedContext,
              "--docker",
              `host=${redirect.host}`,
            ],
            base,
          );
          expect(updated.exitCode, updated.stderr).toBe(0);
        }
        // Selected-context updates, ambient selectors and active-context changes keep the receipt stable.
        env.DOCKER_CONTEXT = redirect.name;
        env.DOCKER_HOST = redirect.host;
        const changed = await run(["context", "use", redirect.name], base);
        expect(changed.exitCode, changed.stderr).toBe(0);
        const ambientPoll = await run(
          ["version", "--format", "{{.Server.Version}}"],
          env,
        );
        expect(ambientPoll.exitCode, ambientPoll.stderr).toBe(0);
        expect(ambientPoll.stdout, version.stdout).not.toBe(ambient.stdout);
        const spec = dockerCommand(target, [
          "version",
          "--format",
          "{{.Server.Version}}",
        ]);
        const child = Bun.spawn(spec.cmd, {
          env: spec.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [output, error, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, `${version.stdout}: ${error}`).toBe(0);
        expect(output.trim(), version.stdout).toBe(ambient.stdout);
      }
    } finally {
      for (const { server } of servers) {
        await server.stop(true);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("a configured host propagates refused CLI discovery", () => {
  const env = {
    DOCKER_HOST: "unix:///tmp/configured.sock",
    DOCKER_CONTEXT: "selected",
  };
  expect(
    resolveDockerTarget({
      env,
      inspect: () =>
        Result.err(
          new DockerEndpointError({ message: "Docker CLI refused discovery" }),
        ),
    }),
  ).toMatchObject({ error: { message: "Docker CLI refused discovery" } });
});

test("a configured keeper propagates development endpoint refusal", () => {
  const target = resolveDockerTarget({
    env: { DOCKER_HOST: "unix:///tmp/protected.sock" },
    inspect: () => Result.ok(dockerInspection("unix:///tmp/protected.sock")),
  }).unwrap();
  const calls: string[][] = [];
  const result = resolveDevDockerKeeper({
    target,
    resolver: "/tools/docker-keeper",
    configuredLabel: "dev.test.override",
    run: (command, env) => {
      calls.push(command);
      expect(env).not.toHaveProperty("DOCKER_HOST");
      return Result.err(
        new DockerEndpointError({ message: "Selected endpoint is protected" }),
      );
    },
  });
  expect(calls).toEqual([
    [
      "/tools/docker-keeper",
      "--purpose",
      "dev",
      "--host",
      target.host,
      "--keeper-label",
      "dev.test.override",
    ],
  ]);
  expect(result).toMatchObject({
    error: { message: "Selected endpoint is protected" },
  });
});

test("an approved unprotected endpoint can use its configured keeper", () => {
  const target = resolveDockerTarget({
    env: {},
    inspect: () => Result.ok(dockerInspection("unix:///tmp/dev.sock")),
  }).unwrap();
  const result = resolveDevDockerKeeper({
    target,
    resolver: "/tools/docker-keeper",
    configuredLabel: "dev.test.keeper",
    run: () => Result.ok(""),
  });
  expect(result.unwrap()).toBe("dev.test.keeper");
});

test("a configured keeper is refused without its policy resolver", () => {
  const target = resolveDockerTarget({
    env: {},
    inspect: () => Result.ok(dockerInspection("unix:///tmp/dev.sock")),
  }).unwrap();
  const result = resolveDevDockerKeeper({
    target,
    resolver: null,
    configuredLabel: "dev.test.keeper",
    run: () => panic("Resolver must not run when absent"),
  });
  expect(result).toMatchObject({
    error: { message: expect.stringContaining("resolver is required") },
  });
});

test.each([
  "unix:///tmp/.colima/default/docker.sock",
  "unix:///tmp/.colima/dev/docker.sock",
])(
  "a Colima endpoint %s requires policy validation even without a keeper label",
  (host) => {
    const target = resolveDockerTarget({
      env: {},
      inspect: () => Result.ok(dockerInspection(host)),
    }).unwrap();
    const result = resolveDevDockerKeeper({
      target,
      resolver: null,
      configuredLabel: undefined,
      run: () => panic("No command may run without the policy resolver"),
    });
    expect(result).toMatchObject({
      error: { message: expect.stringContaining("resolver is required") },
    });
  },
);

test("unmanaged non-Colima Docker remains available without a keeper resolver", () => {
  const target = resolveDockerTarget({
    env: {},
    inspect: () => Result.ok(dockerInspection("unix:///var/run/docker.sock")),
  }).unwrap();
  expect(
    resolveDevDockerKeeper({
      target,
      resolver: null,
      configuredLabel: undefined,
      run: () => panic("No keeper command is needed for an unmanaged endpoint"),
    }),
  ).toMatchObject({ status: "ok", value: undefined });
});

test("command policy rejects an unsupported endpoint option", () => {
  const target = resolveDockerTarget({
    env: {},
    inspect: () => Result.ok(dockerInspection("unix:///tmp/dev.sock")),
  }).unwrap();
  expect(() =>
    Reflect.apply(dockerCommand, undefined, [
      target,
      ["ps", "--context", "other"],
    ]),
  ).toThrow("outside the pinned, mount-safe command policy");
});

test.each([
  { args: ["ps", "--format", "--host"] },
  { args: ["ps", "-f", "label=context"] },
  { args: ["ps", "-flabel=context"] },
  {
    args: [
      "compose",
      "--project-name",
      "dev",
      "--file",
      "/tmp/compose file.yml",
      "--profile",
      "dev",
      "ps",
    ],
  },
  { args: ["compose", "down", "--volumes"] },
  { args: ["volume", "ls", "--format", "{{.Name}}"] },
] as const)(
  "the closed Docker domain preserves safe actions and argument values: %j",
  ({ args }) => {
    const target = resolveDockerTarget({
      env: {},
      inspect: () => Result.ok(dockerInspection("unix:///tmp/dev.sock")),
    }).unwrap();
    expect(dockerCommand(target, args)).toEqual({
      cmd: ["docker", "--host", target.host, ...args],
      env: target.env,
    });
  },
);
