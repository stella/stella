import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "../..");
const inheritedPath = process.env["PATH"];
assert.ok(typeof inheritedPath === "string");

describe("documentation MCP startup", () => {
  for (const installation of ["missing", "partial"]) {
    test(`reports a ${installation} installation without starting an installer`, async () => {
      const directory = mkdtempSync(
        path.join(tmpdir(), "stella-docs-startup-"),
      );
      try {
        cpSync(import.meta.dir, directory, {
          recursive: true,
          filter: (source) =>
            !["node_modules", ".cache"].includes(path.basename(source)),
        });
        const bin = path.join(directory, "bin");
        mkdirSync(bin);
        await Bun.write(
          path.join(bin, "bun"),
          '#!/bin/sh\nprintf "unexpected installer invocation\\n" >&2\nexit 73\n',
        );
        chmodSync(path.join(bin, "bun"), 0o755);
        if (installation === "partial") {
          mkdirSync(
            path.join(directory, "node_modules/@modelcontextprotocol"),
            {
              recursive: true,
            },
          );
        }
        const child = Bun.spawn([process.execPath, "run", "stella-docs.ts"], {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${inheritedPath}`,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).not.toContain("unexpected installer invocation");
        expect(stderr).toContain("bun run setup:mcp");
        expect(stderr).toContain("@modelcontextprotocol/sdk");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  for (const cwd of [repo, path.join(repo, "apps/web")]) {
    test(`completes discovery and a local tool call from ${path.relative(repo, cwd) || "the repository root"}`, async () => {
      const config = Bun.TOML.parse(
        await Bun.file(path.join(repo, ".codex/config.toml")).text(),
      );
      assert.ok(
        config && typeof config === "object" && "mcp_servers" in config,
      );
      const servers = config["mcp_servers"];
      assert.ok(
        servers && typeof servers === "object" && "stella-docs" in servers,
      );
      const server = servers["stella-docs"];
      assert.ok(server && typeof server === "object");
      assert.ok("command" in server && typeof server.command === "string");
      assert.ok("args" in server && Array.isArray(server.args));
      assert.ok(server.args.every((argument) => typeof argument === "string"));
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        cwd,
        stderr: "pipe",
      });
      const client = new Client({ name: "startup-test", version: "1.0.0" });
      try {
        await client.connect(transport, { timeout: 5000 });
        const listed = await client.listTools(undefined, { timeout: 5000 });
        expect(listed.tools.map(({ name }) => name).toSorted()).toEqual([
          "fetch_doc_chunks",
          "fetch_docs",
          "list_doc_sources",
          "search_docs",
        ]);
        const sources = await client.callTool(
          { name: "list_doc_sources", arguments: {} },
          undefined,
          { timeout: 5000 },
        );
        expect(sources.isError).not.toBe(true);
        expect(sources.content).toBeArray();
        expect(sources.content).not.toHaveLength(0);
      } finally {
        await client.close();
      }
    });
  }
});
