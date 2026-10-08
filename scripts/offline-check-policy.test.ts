import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  catalogGeneratorNetworkViolations,
  enumerateOfflineChecks,
  offlineCheckExceptionGrowth,
  offlineCheckViolations,
  parseOfflineCheckExceptions,
  usesOfflineCheckPreload,
} from "./offline-check-policy";

const root = path.resolve(import.meta.dir, "..");
const exceptions = () =>
  parseOfflineCheckExceptions(
    JSON.parse(
      readFileSync(
        path.join(root, "scripts/offline-check-exceptions.json"),
        "utf-8",
      ),
    ),
  );
const workflow = (run: string) => ({ jobs: { checks: { steps: [{ run }] } } });

test("new check invocations cannot bypass the offline preload in nested shell or parallel steps", () => {
  for (const run of [
    "bun scripts/planted-check.ts --check",
    "result=$(bun scripts/planted-check.ts --check)",
    "bun scripts/planted-check.ts \\\n --check",
  ]) {
    const checks = enumerateOfflineChecks({
      jobs: { checks: { steps: [{ parallel: [{ run }] }] } },
    });
    expect(checks).toHaveLength(1);
    expect(offlineCheckViolations(checks, [])).toEqual([
      `Check must use the offline network preload: ${checks[0]?.command}`,
    ]);
  }
  const protectedChecks = enumerateOfflineChecks(
    workflow(
      "bun --preload ./scripts/offline-network-preload.ts scripts/planted-check.ts --check",
    ),
  );
  expect(protectedChecks).toHaveLength(1);
  expect(offlineCheckViolations(protectedChecks, [])).toEqual([]);
});

test("the preload must precede the Bun entry and package-script arguments", () => {
  for (const run of [
    "bun scripts/planted-check.ts --check --preload ./scripts/offline-network-preload.ts",
    "bun run scripts/planted-check.ts --check --preload ./scripts/offline-network-preload.ts",
    "bun scripts/planted-check.ts --check --filter @stll/ai-catalog gen:rates",
  ]) {
    const checks = enumerateOfflineChecks(workflow(run));
    expect(checks).toHaveLength(1);
    expect(checks.at(0)?.protected).toBe(false);
    expect(offlineCheckViolations(checks, [])).toHaveLength(1);
  }
  for (const run of [
    "bun --preload ./scripts/offline-network-preload.ts scripts/planted-check.ts --check",
    "bun run --preload ./scripts/offline-network-preload.ts scripts/planted-check.ts --check",
    "bun --preload=./scripts/offline-network-preload.ts run scripts/planted-check.ts --check",
    "bun --filter @stll/ai-catalog gen:rates --check",
    "bun run --filter @stll/ai-catalog gen:capabilities --check",
  ]) {
    const checks = enumerateOfflineChecks(workflow(run));
    expect(checks).toHaveLength(1);
    expect(checks.at(0)?.protected).toBe(true);
    expect(offlineCheckViolations(checks, [])).toEqual([]);
  }
});

test("expanded package commands obey the same runtime-option boundary", () => {
  const cwd = path.join(root, "packages/ai-catalog");
  const script = "../scripts/src/model-catalog-rates-gen.ts";
  const loader = "../../scripts/offline-network-preload.ts";
  expect(
    usesOfflineCheckPreload(
      ["bun", script, "--check", "--preload", loader],
      cwd,
    ),
  ).toBe(false);
  expect(
    usesOfflineCheckPreload(
      ["bun", "run", script, "--check", "--preload", loader],
      cwd,
    ),
  ).toBe(false);
  expect(
    usesOfflineCheckPreload(
      ["bun", "--preload", loader, script, "--check"],
      cwd,
    ),
  ).toBe(true);
  expect(
    usesOfflineCheckPreload(
      ["bun", "run", "--preload", loader, script, "--check"],
      cwd,
    ),
  ).toBe(true);
  expect(
    usesOfflineCheckPreload(
      ["node", "--preload", loader, script, "--check"],
      cwd,
    ),
  ).toBe(false);
});

test("check exceptions are reasoned, shrink only, and cannot outlive the raw invocation", () => {
  const checks = enumerateOfflineChecks(
    workflow("bun scripts/planted-check.ts --check"),
  );
  const command = checks.at(0)?.command;
  if (command === undefined) {
    panic("Planted check was not enumerated");
  }
  const baseline = [{ command, reason: "Existing local verification" }];
  expect(offlineCheckViolations(checks, baseline)).toEqual([]);
  expect(offlineCheckViolations([], baseline)).toEqual([
    `Stale offline check exception: ${command}`,
  ]);
  expect(offlineCheckExceptionGrowth([], baseline)).toEqual([]);
  expect(offlineCheckExceptionGrowth(baseline, [])).toEqual([
    `Offline check exceptions may only shrink: ${command}`,
  ]);
  expect(() => parseOfflineCheckExceptions([{ command, reason: "" }])).toThrow(
    "Every offline check exception needs a command and reason",
  );
});

test("catalog generator enumeration confines newly introduced transports to the snapshot owner", () => {
  const clean = new Map([
    ["model-catalog-new-gen.ts", "await readSnapshot();"],
  ]);
  expect(catalogGeneratorNetworkViolations(clean, [])).toEqual([]);
  const planted = new Map([
    ["model-catalog-new-gen.ts", "await fetch('https://example.invalid');"],
  ]);
  expect(catalogGeneratorNetworkViolations(planted, [])).toEqual([
    "Catalog generator transport must be owned by model-catalog-snapshot.ts: Check must use the offline network preload: model-catalog-new-gen.ts",
  ]);
});

test("committed check invocations and catalog generator transports are exhaustively classified", () => {
  const checks = enumerateOfflineChecks(
    Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
    ),
  );
  expect(checks.length).toBeGreaterThan(0);
  expect(offlineCheckViolations(checks, exceptions())).toEqual([]);
  const sourceRoot = path.join(root, "packages/scripts/src");
  const sources = new Map(
    [
      ...new Bun.Glob("model-catalog-*-gen.ts").scanSync({ cwd: sourceRoot }),
    ].map((file) => [file, readFileSync(path.join(sourceRoot, file), "utf-8")]),
  );
  expect(sources.size).toBeGreaterThan(0);
  expect(catalogGeneratorNetworkViolations(sources, exceptions())).toEqual([]);
});

const runPreloaded = (code: string, mode: string) =>
  Bun.spawnSync(
    [
      process.execPath,
      "--preload",
      path.join(root, "scripts/offline-network-preload.ts"),
      "--eval",
      code,
      "--",
      mode,
    ],
    { cwd: root },
  );

test("the check preload denies every fetch invocation", () => {
  const planted = runPreloaded(
    "await fetch('data:text/plain,planted');",
    "--check",
  );
  expect(planted.exitCode).not.toBe(0);
  expect(planted.stderr.toString()).toContain(
    "network disabled in offline check",
  );
});

test.each([
  [
    "node:https.get",
    "import https from 'node:https'; https.get('https://127.0.0.1:1');",
  ],
  [
    "named node:https.get",
    "import { get } from 'node:https'; get('https://127.0.0.1:1');",
  ],
  [
    "node:http.request",
    "import http from 'node:http'; http.request('http://127.0.0.1:1');",
  ],
  [
    "node:http.get",
    "import http from 'node:http'; http.get('http://127.0.0.1:1');",
  ],
  [
    "node:https.request",
    "import https from 'node:https'; https.request('https://127.0.0.1:1');",
  ],
  ["node:http.Agent", "import http from 'node:http'; new http.Agent();"],
  ["node:https.Agent", "import https from 'node:https'; new https.Agent();"],
  [
    "node:http.globalAgent",
    "import http from 'node:http'; http.globalAgent.createConnection({port: 1, host: '127.0.0.1'});",
  ],
  [
    "node:http.ClientRequest",
    "import http from 'node:http'; new http.ClientRequest('http://127.0.0.1:1');",
  ],
  [
    "node:net.connect",
    "import net from 'node:net'; net.connect(1, '127.0.0.1');",
  ],
  [
    "node:net.createConnection",
    "import net from 'node:net'; net.createConnection(1, '127.0.0.1');",
  ],
  [
    "node:net.Socket.connect",
    "import net from 'node:net'; new net.Socket().connect(1, '127.0.0.1');",
  ],
  [
    "node:tls.connect",
    "import tls from 'node:tls'; tls.connect(1, '127.0.0.1');",
  ],
  ["node:tls.TLSSocket", "import tls from 'node:tls'; new tls.TLSSocket();"],
  [
    "node:dns.lookup",
    "import dns from 'node:dns'; dns.lookup('localhost', () => {});",
  ],
  [
    "node:dns.resolve",
    "import dns from 'node:dns'; dns.resolve('localhost', () => {});",
  ],
  [
    "node:dns/promises.lookup",
    "import dns from 'node:dns/promises'; await dns.lookup('localhost');",
  ],
  ["node:dns.Resolver", "import dns from 'node:dns'; new dns.Resolver();"],
  [
    "Bun.connect",
    "await Bun.connect({hostname: '127.0.0.1', port: 1, socket: {data() {}}});",
  ],
  ["Bun.dns.lookup", "await Bun.dns.lookup('localhost');"],
  ["Bun.udpSocket", "await Bun.udpSocket({port: 0});"],
  ["WebSocket", "new WebSocket('ws://127.0.0.1:1');"],
  [
    "node:http2.connect",
    "import http2 from 'node:http2'; http2.connect('http://127.0.0.1:1');",
  ],
  [
    "node:dgram.createSocket",
    "import dgram from 'node:dgram'; dgram.createSocket('udp4');",
  ],
])(
  "offline check denies %s with the shared typed error",
  (_transport, code) => {
    const planted = runPreloaded(code, "--check");
    expect(planted.exitCode).not.toBe(0);
    expect(planted.stderr.toString()).toContain("OfflineCheckNetworkError");
    expect(planted.stderr.toString()).toContain(
      "network disabled in offline check",
    );
  },
);

test("offline check enumerates every DNS resolver and lookup entry point", () => {
  const planted = runPreloaded(
    `
    import dns from 'node:dns';
    import promises from 'node:dns/promises';
    let denied = 0;
    for (const target of [dns, promises, Bun.dns]) {
      for (const key of Object.getOwnPropertyNames(target).filter(key => /^(?:lookup|resolve|reverse|prefetch)/u.test(key))) {
        try {
          target[key]('localhost', () => {});
        } catch (error) {
          if (error._tag !== 'OfflineCheckNetworkError' || error.message !== 'network disabled in offline check') throw error;
          denied++;
          continue;
        }
        throw new Error('DNS entry point allowed: ' + key);
      }
    }
    console.log('DNS denials: ' + denied);
  `,
    "--check",
  );
  expect(planted.exitCode).not.toBe(0);
  expect(planted.stderr.toString()).toBe("");
  expect(planted.stdout.toString()).toMatch(/DNS denials: [1-9]\d*/u);
});

test("offline checks pass without transport and reject a planted network fetch before reaching upstream", () => {
  const clean = runPreloaded(
    "console.log('offline input verified');",
    "--check",
  );
  expect(clean.exitCode).toBe(0);
  expect(clean.stdout.toString()).toContain("offline input verified");
  const planted = runPreloaded(
    "await fetch('https://example.invalid');",
    "--check",
  );
  expect(planted.exitCode).not.toBe(0);
  expect(planted.stderr.toString()).toContain(
    "network disabled in offline check",
  );
  const swallowed = runPreloaded(
    "await Promise.resolve().then(() => fetch('https://example.invalid')).catch(() => {});",
    "--check",
  );
  expect(swallowed.exitCode).not.toBe(0);
  const refresh = runPreloaded(
    "console.log(await (await fetch('data:text/plain,refresh')).text());",
    "--refresh",
  );
  expect(refresh.exitCode).toBe(0);
  expect(refresh.stdout.toString()).toContain("refresh");
});
