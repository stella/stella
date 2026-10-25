import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
// No probe deadline: the plugin waits its design-system workers out, bounded
// only far past any slow load, so a slow runner makes this probe slower, never
// red. Phase timings go to stderr.
const CHILD_MODE = "--probe";
const RULE = "no-conflicting-classes";
const BENIGN = "size-[1em] object-contain";
const CONFLICTING = "size-[1em] w-[2em]";

const probe = async () => {
  const started = performance.now();
  const phase = (name: string) =>
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
  const { RuleTester } = await import("oxlint/plugins-dev");
  const rule = plugin.rules[RULE];
  assert.ok(rule, "the declarations rule must exist");
  const tester = new RuleTester({ cwd: ROOT });
  const filename = path.join(ROOT, "packages/chat/src/link.tsx");
  phase("app.css declarations worker");
  tester.run(RULE, rule, {
    valid: [
      {
        code: `<span className="${BENIGN}" />`,
        filename,
        settings: { tailwindcss: config.settings.tailwindcss },
      },
    ],
    invalid: [
      {
        code: `<span className="${CONFLICTING}" />`,
        filename,
        settings: { tailwindcss: config.settings.tailwindcss },
        errors: [
          {
            messageId: "conflictUnordered",
            data: {
              classA: "size-[1em]",
              classB: "w-[2em]",
              properties: '"width"',
            },
          },
        ],
      },
    ],
  });
  process.stdout.write(
    `${JSON.stringify({
      rule: RULE,
      elapsedMs: Math.round(performance.now() - started),
      runtime: process.version,
      conflict: "conflictUnordered",
      properties: '"width"',
    })}\n`,
  );
};

if (process.argv.at(2) === CHILD_MODE) {
  await probe();
} else {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [import.meta.filename, CHILD_MODE],
    {
      cwd: ROOT,
      encoding: "utf-8",
    },
  );
  process.stderr.write(result.stderr);
  const status = childExitStatus(result);
  if (status !== 0) {
    process.stderr.write(
      `Design-system worker probe failed (signal=${result.signal ?? "none"}).\n`,
    );
    process.exitCode = status;
  } else {
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.conflict, "conflictUnordered");
    process.stdout.write(
      `${JSON.stringify({ ...receipt, totalMs: Math.round(performance.now() - started) })}\n`,
    );
  }
}
