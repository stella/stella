import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { childExitStatus } from "../packages/scripts/src/child-exit-status.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEADLINE_MS = 30_000;
const CHILD_MODE = "--probe";
const RULE = "no-conflicting-classes";
const BENIGN = "size-[1em] object-contain";
const CONFLICTING = "size-[1em] w-[2em]";

const probe = async () => {
  const started = performance.now();
  const phase = (name) =>
    process.stderr.write(
      `design-system probe: ${name} (${Math.round(performance.now() - started)}ms)\n`,
    );
  phase("Node design config import");
  // Load the config that reaches the collation export before starting the
  // Tailwind service. A plain TypeScript loader fixture never starts it.
  await import("../oxlint.design.config.ts");
  const [{ default: config }, { default: plugin }] = await Promise.all([
    import("../oxlint.config.ts"),
    import("oxlint-tailwindcss"),
  ]);
  const reports = [];
  const visitor = plugin.rules[RULE].createOnce({
    cwd: ROOT,
    filename: path.join(ROOT, "packages/chat/src/link.tsx"),
    settings: config.settings,
    options: [{}],
    report: (diagnostic) => reports.push(diagnostic),
  });
  const check = (value) => {
    const literal = { type: "Literal", value, range: [0, value.length + 2] };
    const attribute = {
      type: "JSXAttribute",
      name: { type: "JSXIdentifier", name: "className" },
      value: literal,
      parent: {
        type: "JSXOpeningElement",
        name: { type: "JSXIdentifier", name: "span" },
      },
    };
    visitor.JSXAttribute(attribute);
  };
  phase("app.css declarations worker");
  check(BENIGN);
  assert.deepEqual(
    reports,
    [],
    "benign arbitrary classes must load without a worker failure",
  );
  check(CONFLICTING);
  assert.equal(reports.length, 1, "the declaration comparison must execute");
  const diagnostic = reports.at(0);
  assert.equal(diagnostic.messageId, "conflictUnordered");
  assert.equal(diagnostic.data.properties, '\"width\"');
  process.stdout.write(
    `${JSON.stringify({
      rule: RULE,
      elapsedMs: Math.round(performance.now() - started),
      runtime: process.version,
      bun: process.versions.bun ?? null,
      conflict: diagnostic.messageId,
      properties: diagnostic.data.properties,
    })}\n`,
  );
};

if (process.argv.at(2) === CHILD_MODE) {
  await probe();
} else {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), CHILD_MODE],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: DEADLINE_MS,
      killSignal: "SIGKILL",
    },
  );
  process.stderr.write(result.stderr ?? "");
  const status = childExitStatus(result);
  if (status !== 0) {
    process.stderr.write(
      `Design-system worker probe failed (signal=${result.signal ?? "none"}, deadline=${DEADLINE_MS}ms).\n`,
    );
    process.exitCode = status;
  } else {
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.conflict, "conflictUnordered");
    process.stdout.write(
      `${JSON.stringify({ ...receipt, totalMs: Math.round(performance.now() - started), deadlineMs: DEADLINE_MS })}\n`,
    );
  }
}
