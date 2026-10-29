import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  bunfigRuntimePreloadViolations,
  catalogGeneratorNetworkViolations,
  enumerateOfflineChecks,
  offlineCheckExceptionGrowth,
  OfflineCheckPolicyError,
  offlineCheckStartupViolations,
  offlineCheckViolations,
  offlineImportGraphViolations,
  parseOfflineCheckExceptions,
  parseOfflineImportAllowances,
  protectedOfflineCheckCallerViolations,
  trackedOfflineCheckCallerSources,
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
    const check = checks.at(0) ?? panic("Missing planted check invocation");
    expect(offlineCheckViolations(checks, [])).toEqual([
      `Check must use the offline network preload: ${check.command}`,
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

test("protected caller census covers manifests, turbo commands, workflows, and test spawns", () => {
  const entry = path.join(root, "scripts/protected-check.ts");
  const badCommand = "bun scripts/protected-check.ts --check";
  const goodCommand =
    "bun --preload ./scripts/offline-network-preload.ts scripts/protected-check.ts --check";
  const violations = protectedOfflineCheckCallerViolations(
    [entry],
    [
      {
        file: "package.json",
        source: JSON.stringify({
          scripts: { bad: badCommand, good: goodCommand },
        }),
        type: "package",
      },
      {
        file: "turbo.json",
        source: JSON.stringify({ tasks: { check: { command: badCommand } } }),
        type: "turbo",
      },
      {
        file: ".github/workflows/check.yml",
        source: Bun.YAML.stringify({
          jobs: { check: { steps: [{ run: badCommand }] } },
        }),
        type: "workflow",
      },
      {
        file: "scripts/check.test.ts",
        source: `Bun.spawn([process.execPath, "scripts/protected-check.ts", "--check"]);`,
        type: "test",
      },
    ],
  );
  expect(violations).toHaveLength(4);
  expect(violations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("package.json:1"),
      expect.stringContaining("turbo.json:1"),
      expect.stringContaining(".github/workflows/check.yml:1"),
      expect.stringContaining("scripts/check.test.ts:1"),
    ]),
  );
  for (const violation of violations) {
    expect(violation).toContain(
      "add `--preload ./scripts/offline-network-preload.ts` before the entry",
    );
  }
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
  expect(
    offlineCheckStartupViolations(
      checks.flatMap((check) =>
        check.protected && check.entry !== null ? [check.entry] : [],
      ),
    ),
  ).toEqual([]);
  expect(
    protectedOfflineCheckCallerViolations(
      checks.flatMap((check) =>
        check.protected && check.entry !== null ? [check.entry] : [],
      ),
      trackedOfflineCheckCallerSources(),
    ),
  ).toEqual([]);
  const sourceRoot = path.join(root, "packages/scripts/src");
  const sources = new Map(
    [
      ...new Bun.Glob("model-catalog-*-gen.ts").scanSync({ cwd: sourceRoot }),
    ].map((file) => [file, readFileSync(path.join(sourceRoot, file), "utf-8")]),
  );
  expect(sources.size).toBeGreaterThan(0);
  expect(catalogGeneratorNetworkViolations(sources, exceptions())).toEqual([]);
});

test("startup proof requires the canonical runtime binding in an executed entry branch", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "offline-startup-proof-"));
  const entry = path.join(directory, "check.ts");
  const owner = path.join(root, "scripts/offline-check-startup.ts");
  const imported = `import { assertOfflineCheckPreload } from ${JSON.stringify(owner)};`;
  const cases = [
    { source: `${imported} assertOfflineCheckPreload();`, valid: true },
    {
      source: `${imported} if (import.meta.main) { assertOfflineCheckPreload(); }`,
      valid: true,
    },
    {
      source: `import { assertOfflineCheckPreload as guard } from ${JSON.stringify(owner)}; if (import.meta.main) { guard(); }`,
      valid: true,
    },
    { source: `${imported} // assertOfflineCheckPreload();`, valid: false },
    {
      source: `${imported} const text = "assertOfflineCheckPreload();";`,
      valid: false,
    },
    {
      source: `${imported} const unused = () => assertOfflineCheckPreload();`,
      valid: false,
    },
    {
      source: `${imported} if (false) { assertOfflineCheckPreload(); }`,
      valid: false,
    },
    {
      source: `${imported} if (import.meta.main) { const unused = () => assertOfflineCheckPreload(); }`,
      valid: false,
    },
    {
      source: `${imported} function unused(assertOfflineCheckPreload) { assertOfflineCheckPreload(); }`,
      valid: false,
    },
    {
      source: `${imported} if (import.meta.main) { assertOfflineCheckPreload(); function assertOfflineCheckPreload() {} }`,
      valid: false,
    },
    {
      source: `${imported} if (import.meta.main) { assertOfflineCheckPreload(); function unrelated(assertOfflineCheckPreload) {} }`,
      valid: true,
    },
    {
      source: `${imported} if (import.meta.main) { assertOfflineCheckPreload(); if (flag) { const assertOfflineCheckPreload = () => {}; } }`,
      valid: true,
    },
    {
      source: `${imported} if (import.meta.main) { assertOfflineCheckPreload(); const { guard: assertOfflineCheckPreload } = helpers; }`,
      valid: false,
    },
    {
      source: `${imported} doCheckWork(); assertOfflineCheckPreload();`,
      valid: false,
    },
    {
      source: `import type { assertOfflineCheckPreload } from ${JSON.stringify(owner)}; assertOfflineCheckPreload();`,
      valid: false,
    },
    {
      source:
        'import { assertOfflineCheckPreload } from "./offline-check-startup"; assertOfflineCheckPreload();',
      valid: false,
    },
  ];
  try {
    writeFileSync(
      path.join(directory, "offline-check-startup.ts"),
      "export const assertOfflineCheckPreload = () => {};\n",
    );
    for (const { source, valid } of cases) {
      writeFileSync(entry, source);
      expect(offlineCheckStartupViolations([entry]), source).toHaveLength(
        valid ? 0 : 1,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracked bunfig files cannot displace the command-line network preload", () => {
  expect(
    bunfigRuntimePreloadViolations(
      new Map([
        ["bunfig.toml", '[install]\nauto = "disable"\n'],
        ["apps/web/bunfig.toml", '[test]\npreload = ["./setup.ts"]\n'],
      ]),
    ),
  ).toEqual([]);
  expect(
    bunfigRuntimePreloadViolations(
      new Map([["bunfig.toml", 'preload = ["./runtime.ts"]\n']]),
    ),
  ).toEqual([
    "Tracked bunfig must not declare a top-level runtime preload: bunfig.toml",
  ]);
});

test("a displaced command-line preload makes check startup fail closed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "offline-preload-"));
  try {
    writeFileSync(
      path.join(directory, "bunfig.toml"),
      'preload = ["./runtime-preload.ts"]\n',
    );
    writeFileSync(
      path.join(directory, "runtime-preload.ts"),
      `const defineProperty = Object.defineProperty;
Object.defineProperty = (target, key, descriptor) =>
  target === globalThis && key === Symbol.for("stella.offline-check-preload")
    ? target
    : defineProperty(target, key, descriptor);
`,
    );
    writeFileSync(
      path.join(directory, "check.ts"),
      `import { assertOfflineCheckPreload } from ${JSON.stringify(path.join(root, "scripts/offline-check-startup.ts"))};\nassertOfflineCheckPreload();\nconsole.log("check ran");\n`,
    );
    const displaced = Bun.spawnSync(
      [
        process.execPath,
        "--preload",
        path.join(root, "scripts/offline-network-preload.ts"),
        "./check.ts",
        "--check",
      ],
      { cwd: directory },
    );
    expect(displaced.exitCode).not.toBe(0);
    expect(displaced.stderr.toString()).toContain("OfflineCheckPreloadMissing");
    expect(displaced.stderr.toString()).toContain(
      "run this check with `bun --preload ./scripts/offline-network-preload.ts <check> --check`",
    );
    expect(displaced.stdout.toString()).not.toContain("check ran");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("check startup accepts the installed network preload sentinel", () => {
  const checked = runPreloaded(
    "const { assertOfflineCheckPreload } = await import('./scripts/offline-check-startup.ts'); assertOfflineCheckPreload(); console.log('check ran');",
    "--check",
  );
  expect(checked.exitCode).toBe(0);
  expect(checked.stdout.toString()).toContain("check ran");
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
  [
    "node:child_process.exec",
    "import childProcess from 'node:child_process'; childProcess.exec('curl https://example.invalid');",
  ],
  ["Bun.spawn", "Bun.spawn(['curl', 'https://example.invalid']);"],
  ["Bun.$", "await Bun.$`curl https://example.invalid`;"],
])(
  "offline check denies %s with the shared typed error",
  (_transport, code) => {
    const planted = runPreloaded(code, "--check");
    expect(planted.exitCode).not.toBe(0);
    expect(planted.stderr.toString()).toContain("OfflineCheckNetworkError");
    expect(planted.stderr.toString()).toContain(
      "network disabled in offline check",
    );
    expect(planted.stderr.toString()).toContain("[eval]");
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
          if (error._tag !== 'OfflineCheckNetworkError' || !error.message.startsWith('network disabled in offline check:')) throw error;
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

test.each([
  "fetch('https://example.invalid')",
  "globalThis.fetch('https://example.invalid')",
  "Bun.fetch('https://example.invalid')",
  "Bun.connect({ hostname: 'localhost', port: 1 })",
  "Bun.listen({ port: 1 })",
  "Bun.spawn(['curl', 'https://example.invalid'])",
  "Bun.spawnSync(['curl', 'https://example.invalid'])",
  "Bun['fetch']('https://example.invalid')",
  "const runtime = Bun; runtime.fetch('https://example.invalid')",
  "import { exec } from 'node:child_process'; exec('curl https://example.invalid')",
])(
  "offline import closures reject a nested helper containing %s",
  (transport) => {
    const directory = mkdtempSync(path.join(tmpdir(), "offline-closure-"));
    try {
      const entry = path.join(directory, "check.ts");
      writeFileSync(entry, "import './helper'; // --check\n");
      writeFileSync(path.join(directory, "helper.ts"), "import './nested';\n");
      writeFileSync(path.join(directory, "nested.ts"), transport);
      const violations = offlineImportGraphViolations({
        entries: [entry],
        repositoryRoot: directory,
      });
      expect(violations).toHaveLength(1);
      expect(violations.at(0)).toBeInstanceOf(OfflineCheckPolicyError);
      expect(violations.at(0)?.message).toContain("nested.ts:");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("offline closure inspects extensionless modules while preserving inert assets", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "offline-extensionless-"));
  try {
    const entry = path.join(directory, "check.ts");
    writeFileSync(
      entry,
      "require('./helper'); import data from './data.json' with { type: 'json' }; import text from './generated.js.txt' with { type: 'text' }; void data; void text;",
    );
    writeFileSync(
      path.join(directory, "helper"),
      "Bun.spawn(['curl', 'https://example.invalid']);",
    );
    writeFileSync(
      path.join(directory, "data.json"),
      JSON.stringify({ source: "Bun.fetch('https://example.invalid')" }),
    );
    writeFileSync(
      path.join(directory, "generated.js.txt"),
      "Bun.fetch('https://example.invalid');",
    );

    const violations = offlineImportGraphViolations({
      entries: [entry],
      repositoryRoot: directory,
    });
    expect(violations).toHaveLength(1);
    expect(violations.at(0)?.message).toContain("helper: Bun.spawn");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline closure classifies text-suffixed modules by the import edge loader", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "offline-loader-"));
  try {
    const entry = path.join(directory, "check.ts");
    const payload = path.join(directory, "payload.txt");
    writeFileSync(
      entry,
      [
        "import defaultText from './payload.txt';",
        "import explicitText from './payload.txt' with { type: 'text' };",
        "import './payload.txt' with { type: 'js' };",
        "await import('./payload.txt', { with: { type: 'js' } });",
        "import data from './data.json' with { type: 'json' };",
        "void defaultText; void explicitText; void data;",
      ].join("\n"),
    );
    writeFileSync(payload, "export const request = Bun.fetch;");
    writeFileSync(
      path.join(directory, "data.json"),
      JSON.stringify({ source: "Bun.spawn(['curl'])" }),
    );

    const violations = offlineImportGraphViolations({
      entries: [entry],
      repositoryRoot: directory,
    });
    expect(violations).toHaveLength(1);
    expect(violations.at(0)?.message).toContain("payload.txt: Bun.fetch");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline closure rejects a dynamic import loader it cannot enumerate", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "offline-loader-"));
  try {
    const entry = path.join(directory, "check.ts");
    writeFileSync(
      entry,
      "const loader = 'js'; await import('./payload.txt', { with: { type: loader } });",
    );
    writeFileSync(
      path.join(directory, "payload.txt"),
      "export const value = 1;",
    );

    expect(
      offlineImportGraphViolations({
        entries: [entry],
        repositoryRoot: directory,
      }).at(0)?.message,
    ).toContain("Import loader cannot be enumerated");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a dynamic module allowance remains exact", () => {
  const source = "await import(target)";
  const directory = mkdtempSync(path.join(tmpdir(), "offline-dynamic-"));
  try {
    const entry = path.join(directory, "check.ts");
    writeFileSync(entry, source);
    const options = { entries: [entry], repositoryRoot: directory };
    expect(offlineImportGraphViolations(options).at(0)?.message).toContain(
      "Dynamic module target cannot be enumerated",
    );
    const allowance = {
      capability: "dynamic-module",
      file: "check.ts",
      reason: "This fixture represents a bounded local module owner.",
    };
    expect(
      offlineImportGraphViolations({ ...options, allowances: [allowance] }),
    ).toEqual([]);
    writeFileSync(entry, `import './other'; ${source}`);
    writeFileSync(path.join(directory, "other.ts"), source);
    expect(
      offlineImportGraphViolations({ ...options, allowances: [allowance] }).at(
        0,
      )?.message,
    ).toContain("other.ts:");
    writeFileSync(entry, "export const value = 1;");
    expect(
      offlineImportGraphViolations({ ...options, allowances: [allowance] }).at(
        0,
      )?.message,
    ).toContain("Stale offline import allowance");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline closure follows workspace symlinks and excludes external packages", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "offline-workspace-"));
  try {
    const entry = path.join(directory, "check.ts");
    const workspace = path.join(directory, "packages/helper");
    const modules = path.join(directory, "node_modules");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(modules);
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "helper", exports: "./helper.ts" }),
    );
    writeFileSync(
      path.join(workspace, "helper.ts"),
      "export const request = Bun.fetch;",
    );
    symlinkSync(workspace, path.join(modules, "helper"), "dir");
    writeFileSync(entry, "import 'helper';");
    expect(
      offlineImportGraphViolations({
        entries: [entry],
        repositoryRoot: directory,
      }).at(0)?.message,
    ).toContain("packages/helper/helper.ts: Bun.fetch");
    writeFileSync(
      path.join(workspace, "helper.ts"),
      "// Bun.fetch()\nexport const text = 'Bun.spawn()';",
    );
    const external = path.join(modules, "external");
    mkdirSync(external);
    writeFileSync(
      path.join(external, "package.json"),
      JSON.stringify({ name: "external", exports: "./index.ts" }),
    );
    writeFileSync(
      path.join(external, "index.ts"),
      "Bun.fetch('https://example.invalid');",
    );
    writeFileSync(entry, "import 'helper'; import 'external';");
    expect(
      offlineImportGraphViolations({
        entries: [entry],
        repositoryRoot: directory,
      }),
    ).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline import allowances are reasoned, exact, and cannot hide a new capability", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "offline-allowlist-"));
  try {
    const entry = path.join(directory, "check.ts");
    writeFileSync(entry, "await fetch('https://example.invalid');");
    expect(
      offlineImportGraphViolations({
        allowances: [
          {
            capability: "fetch",
            file: "check.ts",
            reason: "Refresh transport is dormant during verification.",
          },
        ],
        entries: [entry],
        repositoryRoot: directory,
      }),
    ).toEqual([]);
    const stale = offlineImportGraphViolations({
      allowances: [
        {
          capability: "Bun.spawn",
          file: "check.ts",
          reason: "Planted stale entry.",
        },
      ],
      entries: [entry],
      repositoryRoot: directory,
    });
    expect(stale.map(({ message }) => message)).toEqual([
      "Offline check import graph: check.ts: Raw fetch must remain in the snapshot transport owner",
      "Stale offline import allowance: check.ts:Bun.spawn",
    ]);
    expect(() => parseOfflineImportAllowances([{ file: "check.ts" }])).toThrow(
      "Every offline import allowance needs a file, capability, and reason",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every protected blocking check has a transport-safe local import closure", () => {
  const checks = enumerateOfflineChecks(
    Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
    ),
  );
  const entries = checks.flatMap((check) =>
    check.protected && check.entry !== null ? [check.entry] : [],
  );
  expect(entries.length).toBeGreaterThan(0);
  expect(
    offlineImportGraphViolations({
      allowances: parseOfflineImportAllowances(
        JSON.parse(
          readFileSync(
            path.join(root, "scripts/offline-check-import-allowlist.json"),
            "utf-8",
          ),
        ),
      ),
      entries,
      repositoryRoot: root,
    }),
  ).toEqual([]);
});
