import { expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("compiled YARA scanner loads external rules and detects active SVG content", () => {
  const testDir = mkdtempSync(path.join(tmpdir(), "stella-yara-artifact-"));
  const rulesDir = path.join(testDir, "rules");
  const entrypoint = path.join(testDir, "probe.ts");
  const executable = path.join(testDir, "probe");
  const ruleFiles = readdirSync(path.join(import.meta.dir, "yara")).filter(
    (name) => name.endsWith(".yar"),
  );
  expect(ruleFiles.length).toBeGreaterThan(0);

  try {
    cpSync(path.join(import.meta.dir, "yara"), rulesDir, { recursive: true });
    writeFileSync(
      entrypoint,
      `import { yaraRuleFileCount, yaraScanner } from ${JSON.stringify(path.join(import.meta.dir, "yara.ts"))};
const active = await yaraScanner.scan(new TextEncoder().encode('<svg><script>alert(1)</script></svg>'));
const benign = await yaraScanner.scan(new TextEncoder().encode('<svg><rect width="1" height="1"/></svg>'));
process.stdout.write(JSON.stringify({ count: yaraRuleFileCount, active, benign }));
`,
    );
    const build = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--outfile",
        executable,
        entrypoint,
      ],
      cwd: path.resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);

    const run = Bun.spawnSync({
      cmd: [executable],
      cwd: testDir,
      env: {
        PATH: process.env["PATH"] ?? "",
        STELLA_YARA_RULES_DIR: rulesDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    const output: unknown = JSON.parse(new TextDecoder().decode(run.stdout));
    expect(output).toMatchObject({
      count: ruleFiles.length,
      active: expect.arrayContaining([
        expect.objectContaining({
          rule: "svg_script_tag",
          severity: "suspicious",
        }),
      ]),
      benign: [],
    });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
}, 30_000);
