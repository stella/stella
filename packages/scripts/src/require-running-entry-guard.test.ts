import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..");
const RULE_NAME = "require-running-entry-guard";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { recursive: true, force: true }),
      ),
  );
});

const lint = async (source: string) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "stella-running-entry-guard-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({
      jsPlugins: [
        path.join(REPOSITORY_ROOT, ".oxlint-plugins", `${RULE_NAME}.ts`),
      ],
      categories: { correctness: "off" },
      rules: { [`${RULE_NAME}/${RULE_NAME}`]: "error" },
    })};\n`,
  );
  const filename = path.join(directory, "mutation.ts");
  await Bun.write(filename, source);
  const spawned = Bun.spawn(
    [
      process.execPath,
      "--bun",
      "oxlint",
      "-c",
      configPath,
      "-f",
      "json",
      filename,
    ],
    { cwd: REPOSITORY_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, , exitCode] = await Promise.all([
    new Response(spawned.stdout).text(),
    new Response(spawned.stderr).text(),
    spawned.exited,
  ]);
  const count = [
    ...stdout.matchAll(/"code":\s*"require-running-entry-guard\(/gu),
  ].length;
  expect(exitCode, stdout).toBe(count > 0 ? 1 : 0);
  return count;
};

const imports = `
import { timeEntries as entries } from "@/api/db/schema";
import { guardRunningTimeEntries as guard } from "@/api/handlers/time-entries/running";
`;
const mutation = "await tx.update(entries).set({ narrative: 'changed' });";
const guard =
  "const error = await guard({ tx, workspaceId, selection, actorUserId }); if (error) return error;";

test("the running-entry rule accepts awaited imported guards before mutations", async () => {
  expect(
    await lint(
      `${imports} const write = async tx => { ${guard} ${mutation} };`,
    ),
  ).toBe(0);
});

test("the running-entry rule rejects every unguarded mutation", async () => {
  expect(
    await lint(
      `${imports} const write = async tx => { ${mutation} await tx.delete(entries); };`,
    ),
  ).toBe(2);
});

test("the running-entry rule rejects late, nested, unawaited and ignored guards", async () => {
  for (const body of [
    `${mutation} ${guard}`,
    `const nested = async () => { ${guard} }; ${mutation}`,
    `const error = guard({ tx, workspaceId, selection, actorUserId }); if (error) return error; ${mutation}`,
    `await guard({ tx, workspaceId, selection, actorUserId }); ${mutation}`,
  ]) {
    expect(
      await lint(`${imports} const write = async tx => { ${body} };`),
    ).toBe(1);
  }
});

test("a foreign or shadowed helper does not satisfy the running-entry rule", async () => {
  expect(
    await lint(
      `${imports.replace("@/api/handlers/time-entries/running", "./fake")} const write = async tx => { ${guard} ${mutation} };`,
    ),
  ).toBe(1);
  expect(
    await lint(
      `${imports} const write = async (tx, guard) => { ${guard} ${mutation} };`,
    ),
  ).toBe(1);
});

test("the running-entry rule rejects a guard using a different transaction", async () => {
  expect(
    await lint(
      `${imports} const write = async (tx, otherTx) => { const error = await guard({ tx: otherTx, workspaceId, selection, actorUserId }); if (error) return error; ${mutation} };`,
    ),
  ).toBe(1);
});

test("the running-entry rule detects raw entry updates and deletes", async () => {
  expect(
    await lint(
      `${imports} const write = async tx => { await tx.execute(sql\`UPDATE time_entries SET narrative = 'changed'\`); await tx.execute(sql\`DELETE FROM \${entries}\`); };`,
    ),
  ).toBe(2);
});
