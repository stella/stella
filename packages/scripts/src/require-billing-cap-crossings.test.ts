import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..");
const RULE_NAME = "require-billing-cap-crossings";
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
    path.join(tmpdir(), "stella-billing-cap-crossings-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "oxlint.config.ts");
  const pluginPath = path.join(
    REPOSITORY_ROOT,
    ".oxlint-plugins/require-billing-cap-crossings.ts",
  );
  await Bun.write(
    configPath,
    `export default ${JSON.stringify({
      jsPlugins: [pluginPath],
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
    ...stdout.matchAll(/"code":\s*"require-billing-cap-crossings\(/gu),
  ].length;
  expect(exitCode, stdout).toBe(count > 0 ? 1 : 0);
  return count;
};

const imports = `
import { timeEntries as entries } from "@/api/db/schema";
import { recordBillingCapCrossings as reconcile } from "@/api/lib/billing/arrangements";
`;
const mutation = "await tx.update(entries).set({ billable: false });";
const reconciliation =
  "await reconcile(tx, { workspaceId, recordAuditEvent });";

test("canonical batch reconciliation accepts its export name and aliases", async () => {
  for (const localName of [
    "recordBillingCapCrossingsForMatters",
    "reconcile",
  ]) {
    const batchImports = `
      import { timeEntries as entries } from "@/api/db/schema";
      import { recordBillingCapCrossingsForMatters as ${localName} } from "@/api/lib/billing/arrangements";
    `;
    expect(
      await lint(`${batchImports} const write = async tx => {
      ${mutation}
      await ${localName}(tx, { workspaceIds, recordAuditEvent });
    };`),
    ).toBe(0);
  }
});

test("batch reconciliation rejects fake, shadowed, early, nested, unawaited, and foreign-transaction calls", async () => {
  const batchImports = imports.replace(
    "recordBillingCapCrossings as",
    "recordBillingCapCrossingsForMatters as",
  );
  const batchCall = "await reconcile(tx, { workspaceIds, recordAuditEvent });";
  for (const body of [
    `${batchCall} ${mutation}`,
    `${mutation} const later = async () => { ${batchCall} };`,
    `${mutation} reconcile(tx, { workspaceIds, recordAuditEvent });`,
    `${mutation} await reconcile(otherTx, { workspaceIds, recordAuditEvent });`,
  ]) {
    expect(
      await lint(
        `${batchImports} const write = async (tx, otherTx) => { ${body} };`,
      ),
    ).toBe(1);
  }
  expect(
    await lint(
      `${batchImports.replace("@/api/lib/billing/arrangements", "./fake")} const write = async tx => { ${mutation} ${batchCall} };`,
    ),
  ).toBe(1);
  expect(
    await lint(
      `${batchImports} const write = async (tx, reconcile) => { ${mutation} ${batchCall} };`,
    ),
  ).toBe(1);
});

test("approved-value mutation reconciliation accepts canonical awaited imports after writes", async () => {
  for (const hook of [
    reconciliation,
    `if (workspaceId !== null) { ${reconciliation} }`,
    `for (const workspaceId of matters) { ${reconciliation} }`,
  ]) {
    expect(
      await lint(
        `${imports} const write = async tx => { ${mutation} ${hook} };`,
      ),
    ).toBe(0);
  }
});

test("every update or delete requires reconciliation", async () => {
  expect(
    await lint(
      `${imports} const write = async tx => { ${mutation} await tx.delete(entries); };`,
    ),
  ).toBe(2);
});

test("early, nested, unawaited, and foreign-transaction calls do not reconcile a mutation", async () => {
  for (const body of [
    `${reconciliation} ${mutation}`,
    `${mutation} const later = async () => { ${reconciliation} };`,
    `${mutation} reconcile(tx, { workspaceId, recordAuditEvent });`,
    `${mutation} await reconcile(otherTx, { workspaceId, recordAuditEvent });`,
  ]) {
    expect(
      await lint(
        `${imports} const write = async (tx, otherTx) => { ${body} };`,
      ),
    ).toBe(1);
  }
});

test("foreign and shadowed reconciliation helpers do not satisfy the guard", async () => {
  expect(
    await lint(
      `${imports.replace("@/api/lib/billing/arrangements", "./fake")} const write = async tx => { ${mutation} ${reconciliation} };`,
    ),
  ).toBe(1);
  expect(
    await lint(
      `${imports} const write = async (tx, reconcile) => { ${mutation} ${reconciliation} };`,
    ),
  ).toBe(1);
});

test("raw entry updates and deletes require the same transaction's reconciliation", async () => {
  const raw =
    "await tx.execute(sql`UPDATE time_entries SET status = 'approved'`); await tx.execute(sql`DELETE FROM $" +
    "{entries}`);";
  expect(await lint(`${imports} const write = async tx => { ${raw} };`)).toBe(
    2,
  );
  expect(
    await lint(
      `${imports} const write = async tx => { ${raw} ${reconciliation} };`,
    ),
  ).toBe(0);
});

test("reads and other table mutations have no cap reconciliation obligation", async () => {
  expect(
    await lint(
      `${imports} const read = async tx => { await tx.select().from(entries); await tx.update(otherTable).set({ title: 'changed' }); };`,
    ),
  ).toBe(0);
});
