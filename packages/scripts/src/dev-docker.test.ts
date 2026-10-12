import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { dockerCommand, resolveDockerTarget } from "./dev-docker";

test("endpoint resolution preserves the supplied selectors, then pins a captured environment", () => {
  const env = {
    DOCKER_CONTEXT: "chosen",
    DOCKER_HOST: "unix:///tmp/other.sock",
    PATH: "/tools",
  };
  const inspections: NodeJS.ProcessEnv[] = [];
  const target = resolveDockerTarget({
    env,
    inspect: (captured) => {
      inspections.push(captured);
      return "unix:///tmp/chosen.sock\n";
    },
  });
  expect(inspections).toEqual([env]);
  env.DOCKER_CONTEXT = "changed";
  env.DOCKER_HOST = "unix:///tmp/changed.sock";
  env.PATH = "/changed";
  expect(dockerCommand(target, ["compose", "down"])).toEqual({
    cmd: ["docker", "--host", "unix:///tmp/chosen.sock", "compose", "down"],
    env: { PATH: "/tools" },
  });
});

test.each([
  "unix:///tmp/docker.sock",
  "tcp://localhost:2375",
  "ssh://user@host",
  "npipe:////./pipe/docker_engine",
])("accepts supported Docker endpoint transport %s", (host) => {
  expect(resolveDockerTarget({ env: {}, inspect: () => host }).host).toBe(host);
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
  expect(() => resolveDockerTarget({ env: {}, inspect: () => host })).toThrow(
    "valid endpoint",
  );
});

test("clearing selectors preserves transport credentials and other environment", () => {
  const env = {
    DOCKER_HOST: "tcp://other:2376",
    DOCKER_CONTEXT: "other",
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/certificates",
    PATH: "/tools",
  };
  expect(
    resolveDockerTarget({ env, inspect: () => "unix:///tmp/test.sock" }).env,
  ).toEqual({
    DOCKER_TLS_VERIFY: "1",
    DOCKER_CERT_PATH: "/certificates",
    PATH: "/tools",
  });
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
        const resolved = Result.try(() => resolveDockerTarget({ env }));
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
        // Both a changed environment and changed persisted context must leave the target stable.
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
        server.stop(true);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("a configured host cannot bypass a refused CLI discovery", () => {
  const env = {
    DOCKER_HOST: "unix:///tmp/configured.sock",
    DOCKER_CONTEXT: "selected",
  };
  expect(() =>
    resolveDockerTarget({
      env,
      inspect: () => {
        throw new TypeError("Docker CLI refused discovery");
      },
    }),
  ).toThrow("Docker CLI refused discovery");
});
