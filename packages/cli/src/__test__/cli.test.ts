import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractDocxText } from "@stll/anonymize-docx";
import { strToU8, zipSync } from "fflate";

setDefaultTimeout(60_000);

const CLI = new URL("../cli.ts", import.meta.url).pathname;

// Public, minimal fixture: example.com address and the
// standard IBAN test number.
const SAMPLE =
  "Please contact Jan Novák at jan.novak@example.com. " +
  "Pay to IBAN DE89 3704 0044 0532 0130 00.";

// Scope dictionaries to keep test startup small.
const SCOPE = ["--countries", "CZ,DE", "--languages", "cs,en"];

const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const WORD_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const docxArchive = (
  body: string,
  documentRelationships: readonly string[] = [],
): Uint8Array =>
  zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Override PartName="/word/document.xml" ContentType="${DOCUMENT_CONTENT_TYPE}"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:r="${RELATIONSHIP_NAMESPACE}"><w:body>${body}</w:body></w:document>`,
    ),
    ...(documentRelationships.length === 0
      ? {}
      : {
          "word/_rels/document.xml.rels": strToU8(
            `<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}">${documentRelationships.join("")}</Relationships>`,
          ),
        }),
  });

const docx = (text: string): Uint8Array =>
  docxArchive(`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`);

const hyperlinkDocx = (text: string): Uint8Array =>
  docxArchive(
    `<w:p><w:hyperlink r:id="rId2"><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`,
    [
      `<Relationship Id="rId2" Type="${RELATIONSHIP_NAMESPACE}/hyperlink" Target="mailto:person@example.test" TargetMode="External"/>`,
    ],
  );

type RunResult = { out: string; err: string; code: number };

const run = async (args: string[], stdin?: string): Promise<RunResult> => {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    proc.stdin?.write(stdin);
    proc.stdin?.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
};

test("replaces PII from stdin with placeholders", async () => {
  const { out, code } = await run([...SCOPE, "--quiet"], SAMPLE);
  expect(code).toBe(0);
  expect(out).not.toContain("jan.novak@example.com");
  expect(out).not.toContain("DE89 3704 0044 0532 0130 00");
  expect(out).toContain("[EMAIL_ADDRESS_1]");
  expect(out).toContain("[IBAN_1]");
});

test.skipIf(process.platform !== "linux")(
  "redaction key round-trips losslessly",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
    const inputPath = join(dir, "input.txt");
    const outputPath = join(dir, "output.txt");
    const keyPath = join(dir, "key.json");
    await writeFile(inputPath, SAMPLE, "utf8");

    const anon = await run([
      ...SCOPE,
      "--quiet",
      "-o",
      outputPath,
      "-k",
      keyPath,
      inputPath,
    ]);
    expect(anon.code).toBe(0);
    const redacted = await readFile(outputPath, "utf8");
    expect(redacted).not.toContain("jan.novak@example.com");

    const restored = await run(["--quiet", "-d", keyPath, outputPath]);
    expect(restored.code).toBe(0);
    expect(restored.out).toBe(SAMPLE);
  },
);

test.skipIf(process.platform !== "linux")(
  "does not commit a key before stdout completes",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
    const inputPath = join(dir, "input.txt");
    const keyPath = join(dir, "key.json");
    await writeFile(inputPath, "x".repeat(2 * 1024 * 1024), "utf8");

    const proc = Bun.spawn(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        'exec "$@" | head -c 0',
        "anonymize-stdout-test",
        "bun",
        CLI,
        ...SCOPE,
        "--quiet",
        "-k",
        keyPath,
        inputPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [code] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(code).not.toBe(0);
    const key = await stat(keyPath);
    expect(key.size).toBe(0);
    expect(key.mode & 0o777).toBe(0o000);
  },
);

test("redact mode is irreversible and uses the redact string", async () => {
  const { out, code } = await run(
    [...SCOPE, "--quiet", "-m", "redact"],
    SAMPLE,
  );
  expect(code).toBe(0);
  expect(out).toContain("[REDACTED]");
  expect(out).not.toContain("jan.novak@example.com");
  expect(out).not.toContain("[EMAIL_ADDRESS_1]");
});

test("json output carries entities with exact offsets", async () => {
  const { out, code } = await run([...SCOPE, "--quiet", "--json"], SAMPLE);
  expect(code).toBe(0);
  const payload = JSON.parse(out) as {
    entityCount: number;
    entities: { start: number; end: number; text: string }[];
    redactedText: string;
  };
  expect(payload.entityCount).toBeGreaterThan(0);
  for (const entity of payload.entities) {
    expect(SAMPLE.slice(entity.start, entity.end)).toBe(entity.text);
  }
  expect(payload.redactedText).not.toContain("jan.novak@example.com");
});

test("multiple inputs require an output directory", async () => {
  const { code, err } = await run(["a.txt", "b.txt"]);
  expect(code).toBe(2);
  expect(err).toContain("--output");
});

test("unknown flags exit with usage error", async () => {
  const { code, err } = await run(["--nope"], "x");
  expect(code).toBe(2);
  expect(err).toContain("--help");
});

test("refuses to overwrite the input file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const inputPath = join(dir, "input.txt");
  await writeFile(inputPath, SAMPLE, "utf8");
  const { code, err } = await run([...SCOPE, "-o", inputPath, inputPath]);
  expect(code).toBe(2);
  expect(err).toContain("refusing to overwrite");
});

test("refuses a key path that collides with the output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const inputPath = join(dir, "input.txt");
  const outPath = join(dir, "out.txt");
  await writeFile(inputPath, SAMPLE, "utf8");
  const { code, err } = await run([
    ...SCOPE,
    "-o",
    outPath,
    "-k",
    outPath,
    inputPath,
  ]);
  expect(code).toBe(2);
  expect(err).toContain("collides");
});

test.skipIf(process.platform !== "linux")(
  "refuses an occupied key path before replacing output",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
    const inputPath = join(dir, "input.txt");
    const outputPath = join(dir, "output.txt");
    const keyPath = join(dir, "key.json");
    await writeFile(inputPath, SAMPLE, "utf8");
    await writeFile(outputPath, "existing output", "utf8");
    await writeFile(keyPath, "existing key", { mode: 0o600 });

    const { code, err } = await run([
      ...SCOPE,
      "--quiet",
      "-o",
      outputPath,
      "-k",
      keyPath,
      inputPath,
    ]);

    expect(code).toBe(2);
    expect(err).toContain("refuses to overwrite");
    expect(await readFile(outputPath, "utf8")).toBe("existing output");
    expect(await readFile(keyPath, "utf8")).toBe("existing key");
  },
);

test("refuses batch inputs with colliding basenames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const a = join(dir, "a");
  const b = join(dir, "b");
  await Bun.write(join(a, "same.txt"), SAMPLE);
  await Bun.write(join(b, "same.txt"), SAMPLE);
  const { code, err } = await run([
    ...SCOPE,
    "-o",
    join(dir, "out"),
    join(a, "same.txt"),
    join(b, "same.txt"),
  ]);
  expect(code).toBe(2);
  expect(err).toContain("collides");
});

test("--labels accepts short aliases for multi-word labels", async () => {
  // "email" resolves to the canonical "email address" label.
  // Before alias support this hard-errored with exit code 2.
  const { out, code } = await run(
    [...SCOPE, "--quiet", "--labels", "email,email-address,person"],
    SAMPLE,
  );
  expect(code).toBe(0);
  expect(out).not.toContain("jan.novak@example.com");
  expect(out).toContain("[EMAIL_ADDRESS_1]");
});

test("--labels accepts opt-in network labels", async () => {
  const { out, code } = await run(
    [...SCOPE, "--quiet", "--labels", "ip-address"],
    "Connect to 192.0.2.1.",
  );
  expect(code).toBe(0);
  expect(out).toContain("[IP_ADDRESS_1]");
});

test("--labels rejects an unknown label with a usage error", async () => {
  const { err, code } = await run(
    [...SCOPE, "--quiet", "--labels", "definitely-not-a-label"],
    SAMPLE,
  );
  expect(code).toBe(2);
  expect(err).toContain("unknown label");
});

test("--list-labels prints canonical labels and aliases", async () => {
  const { out, code } = await run(["--list-labels"]);
  expect(code).toBe(0);
  expect(out).toContain("person");
  expect(out).toContain("email address");
  expect(out).toContain("ip address");
  expect(out).toContain("mac address");
  expect(out).toContain("url");
  // The alias table maps short forms to canonical labels.
  expect(out).toMatch(/email\s+->\s+email address/);
});

test("--capabilities prints the versioned manifest without reading input", async () => {
  const { out, err, code } = await run(["--capabilities"]);
  const manifest = JSON.parse(out) as {
    schemaVersion: number;
    runtimes: string[];
    entities: { label: string; selection: string }[];
  };

  expect(code).toBe(0);
  expect(err).toBe("");
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.runtimes).toEqual(["node", "python", "wasm"]);
  expect(manifest.entities).toContainEqual(
    expect.objectContaining({ label: "person", selection: "default" }),
  );
  expect(manifest.entities).toContainEqual(
    expect.objectContaining({ label: "ip address", selection: "opt-in" }),
  );
});

test("processes a directory, non-recursive by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const input = join(dir, "in");
  const out = join(dir, "out");
  await Bun.write(join(input, "top.txt"), SAMPLE);
  await Bun.write(join(input, "nested", "deep.txt"), SAMPLE);

  const { code, err } = await run([...SCOPE, "-o", out, input]);
  expect(code).toBe(0);
  // Top-level file is mirrored; the nested file is not walked
  // without --recursive.
  const top = await readFile(join(out, "top.txt"), "utf8");
  expect(top).toContain("[EMAIL_ADDRESS_1]");
  expect(top).not.toContain("jan.novak@example.com");
  expect(await Bun.file(join(out, "nested", "deep.txt")).exists()).toBe(false);
  // Summary reports one processed file.
  expect(err).toContain("1 processed");
});

test("--recursive walks subdirectories and mirrors the tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const input = join(dir, "in");
  const out = join(dir, "out");
  await Bun.write(join(input, "top.txt"), SAMPLE);
  await Bun.write(join(input, "a", "b", "deep.txt"), SAMPLE);

  const { code } = await run([...SCOPE, "--recursive", "-o", out, input]);
  expect(code).toBe(0);
  for (const rel of ["top.txt", join("a", "b", "deep.txt")]) {
    const text = await readFile(join(out, rel), "utf8");
    expect(text).toContain("[EMAIL_ADDRESS_1]");
    expect(text).not.toContain("jan.novak@example.com");
  }
});

test("--recursive skips an output tree nested inside the input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const input = join(dir, "in");
  const out = join(input, "out");
  await Bun.write(join(input, "top.txt"), SAMPLE);

  const first = await run([...SCOPE, "--recursive", "-o", out, input]);
  expect(first.code).toBe(0);
  // Rerun with the output dir already inside the input tree: the walk must
  // not ingest previously generated files as new inputs.
  const second = await run([...SCOPE, "--recursive", "-o", out, input]);
  expect(second.code).toBe(0);
  expect(second.err).toContain("1 processed");
  const nested = join(out, "out", "top.txt");
  expect(existsSync(nested)).toBe(false);
});

test("--workers >1 matches single-worker output (determinism)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const input = join(dir, "in");
  await mkdir(input, { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const name = `f${i}.txt`;
    names.push(name);
    await writeFile(join(input, name), `${SAMPLE} file ${i}`, "utf8");
  }

  const serial = join(dir, "serial");
  const parallel = join(dir, "parallel");
  const a = await run([
    ...SCOPE,
    "--workers",
    "1",
    "--quiet",
    "-o",
    serial,
    input,
  ]);
  const b = await run([
    ...SCOPE,
    "--workers",
    "8",
    "--quiet",
    "-o",
    parallel,
    input,
  ]);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  for (const name of names) {
    const one = await readFile(join(serial, name), "utf8");
    const many = await readFile(join(parallel, name), "utf8");
    expect(many).toBe(one);
  }
});

test("directory walk skips likely-binary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const input = join(dir, "in");
  const out = join(dir, "out");
  await Bun.write(join(input, "text.txt"), SAMPLE);
  // A NUL byte in the first bytes marks the file as binary.
  await Bun.write(
    join(input, "blob.bin"),
    new Uint8Array([0x00, 0x01, 0x02, 0x03]),
  );

  const { code, err } = await run([...SCOPE, "-o", out, input]);
  expect(code).toBe(0);
  expect(await Bun.file(join(out, "text.txt")).exists()).toBe(true);
  expect(await Bun.file(join(out, "blob.bin")).exists()).toBe(false);
  expect(err).toContain("1 processed");
  expect(err).toContain("1 skipped");
});

test("batch reports a nonzero exit when a file fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
  const out = join(dir, "out");
  const good = join(dir, "good.txt");
  await writeFile(good, SAMPLE, "utf8");
  const missing = join(dir, "missing.txt");

  // Two explicit files, one missing. The batch processes the
  // good file and counts the missing one as failed, then exits
  // nonzero.
  const { code, err } = await run([...SCOPE, "-o", out, good, missing]);
  expect(code).toBe(1);
  expect(err).toContain("missing.txt");
  expect(err).toContain("1 processed, 1 failed");
  expect(await Bun.file(join(out, "good.txt")).exists()).toBe(true);
});

test.skipIf(process.platform !== "linux")(
  "--revert restores only the named placeholder",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
    const inputPath = join(dir, "input.txt");
    const redactedPath = join(dir, "redacted.txt");
    const keyPath = join(dir, "key.json");
    await writeFile(inputPath, SAMPLE, "utf8");

    const anon = await run([
      ...SCOPE,
      "--quiet",
      "-o",
      redactedPath,
      "-k",
      keyPath,
      inputPath,
    ]);
    expect(anon.code).toBe(0);

    // Restore only the person; the email stays a placeholder.
    const reverted = await run([
      "--quiet",
      "-d",
      keyPath,
      "--revert",
      "[PERSON_1]",
      redactedPath,
    ]);
    expect(reverted.code).toBe(0);
    expect(reverted.out).toContain("Jan Novák");
    expect(reverted.out).toContain("[EMAIL_ADDRESS_1]");
    expect(reverted.out).not.toContain("jan.novak@example.com");
  },
);

test.skipIf(process.platform !== "linux")(
  "--revert matches an original value and is repeatable",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
    const inputPath = join(dir, "input.txt");
    const redactedPath = join(dir, "redacted.txt");
    const keyPath = join(dir, "key.json");
    await writeFile(inputPath, SAMPLE, "utf8");

    await run([
      ...SCOPE,
      "--quiet",
      "-o",
      redactedPath,
      "-k",
      keyPath,
      inputPath,
    ]);

    // Match by original text for the person, by placeholder for
    // the email: both come back. The IBAN, named by neither, stays
    // redacted.
    const reverted = await run([
      "--quiet",
      "-d",
      keyPath,
      "--revert",
      "Jan Novák",
      "--revert",
      "[EMAIL_ADDRESS_1]",
      redactedPath,
    ]);
    expect(reverted.code).toBe(0);
    expect(reverted.out).toContain("Jan Novák");
    expect(reverted.out).toContain("jan.novak@example.com");
    expect(reverted.out).toContain("[IBAN_1]");
  },
);

test.skipIf(process.platform !== "linux")(
  "--revert errors and lists placeholders on no match",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-"));
    const inputPath = join(dir, "input.txt");
    const redactedPath = join(dir, "redacted.txt");
    const keyPath = join(dir, "key.json");
    await writeFile(inputPath, SAMPLE, "utf8");

    await run([
      ...SCOPE,
      "--quiet",
      "-o",
      redactedPath,
      "-k",
      keyPath,
      inputPath,
    ]);

    const { code, err } = await run([
      "-d",
      keyPath,
      "--revert",
      "Nobody Here",
      redactedPath,
    ]);
    expect(code).toBe(2);
    expect(err).toContain("matched no placeholder or original");
    expect(err).toContain("[PERSON_1]");
  },
);

test("--revert without --deanonymise is a usage error", async () => {
  const { code, err } = await run([...SCOPE, "--revert", "[PERSON_1]"], SAMPLE);
  expect(code).toBe(2);
  expect(err).toContain("--revert requires --deanonymise");
});

test("--json --mode redact omits detected text from the payload", async () => {
  const { out, code } = await run(
    [...SCOPE, "--quiet", "--json", "--mode", "redact"],
    SAMPLE,
  );
  expect(code).toBe(0);

  const payload = JSON.parse(out) as {
    entityCount: number;
    entities: Array<Record<string, unknown>>;
    redactedText: string;
  };

  expect(payload.entityCount).toBeGreaterThan(0);
  for (const e of payload.entities) {
    expect(e).not.toHaveProperty("text");
    expect(e).not.toHaveProperty("corefSourceText");
  }
  // No detected PII anywhere in the JSON.
  expect(out).not.toContain("jan.novak@example.com");
  expect(out).not.toContain("Novák");
  expect(payload.redactedText).toContain("[REDACTED]");
});

test("DOCX encrypted-session workflow anonymizes and restores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-docx-"));
  const inputPath = join(dir, "input.docx");
  const anonymizedPath = join(dir, "anonymized.docx");
  const restoredPath = join(dir, "restored.docx");
  const archivePath = join(dir, "session.stlasession");
  const keyPath = join(dir, "session.key");
  const originalText = "Contact person@example.test";
  await writeFile(inputPath, docx(originalText));
  // Deterministic public fixture key; production keys must be random.
  await writeFile(keyPath, new Uint8Array(32).fill(7));
  await chmod(keyPath, 0o600);

  const anonymized = await run([
    "docx",
    "anonymize",
    "--session-mode",
    "create",
    "--session-archive",
    archivePath,
    "--session-key-file",
    keyPath,
    "--session-id",
    "matter_1",
    "--labels",
    "email",
    "--languages",
    "en",
    "--countries",
    "US",
    "--json",
    "--output",
    anonymizedPath,
    inputPath,
  ]);
  expect(anonymized.code).toBe(0);
  expect(anonymized.out).not.toContain("person@example.test");
  expect(JSON.parse(anonymized.out)).toMatchObject({
    sessionId: "matter_1",
    entityCount: 1,
    coverage: { status: "full" },
  });
  expect(
    extractDocxText(await readFile(anonymizedPath)).blocks.at(0)?.text,
  ).toBe("Contact [EMAIL_ADDRESS_matter%5F1_1]");
  expect((await readFile(archivePath)).byteLength).toBeGreaterThan(0);

  const continuedInputPath = join(dir, "continued-input.docx");
  const continuedOutputPath = join(dir, "continued-output.docx");
  const continuedArchivePath = join(dir, "continued-session.stlasession");
  const archiveBeforeLock = await readFile(archivePath);
  const lockPath = `${archivePath}.lock`;
  await writeFile(continuedInputPath, docx("Contact second@example.test"));
  await symlink(archivePath, continuedArchivePath);
  await writeFile(lockPath, "", { mode: 0o600 });
  const refusedContinuation = await run([
    "docx",
    "anonymize",
    "--session-mode",
    "continue",
    "--session-archive",
    continuedArchivePath,
    "--session-key-file",
    keyPath,
    "--session-id",
    "matter_1",
    "--labels",
    "email",
    "--languages",
    "en",
    "--countries",
    "US",
    "--output",
    continuedOutputPath,
    continuedInputPath,
  ]);
  expect(refusedContinuation.code).toBe(1);
  expect(refusedContinuation.err).toContain(
    "session archive is locked by another continuation",
  );
  expect(await Bun.file(continuedOutputPath).exists()).toBeFalse();
  expect(await readFile(archivePath)).toEqual(archiveBeforeLock);
  await unlink(lockPath);

  const continued = await run([
    "docx",
    "anonymize",
    "--session-mode",
    "continue",
    "--session-archive",
    continuedArchivePath,
    "--session-key-file",
    keyPath,
    "--session-id",
    "matter_1",
    "--labels",
    "email",
    "--languages",
    "en",
    "--countries",
    "US",
    "--output",
    continuedOutputPath,
    continuedInputPath,
  ]);
  expect(continued.code).toBe(0);
  expect(
    extractDocxText(await readFile(continuedOutputPath)).blocks.at(0)?.text,
  ).toBe("Contact [EMAIL_ADDRESS_matter%5F1_2]");
  expect(await readFile(archivePath)).not.toEqual(archiveBeforeLock);
  expect((await lstat(continuedArchivePath)).isSymbolicLink()).toBeTrue();
  expect(await Bun.file(lockPath).exists()).toBeFalse();

  const partialInputPath = join(dir, "anonymized-hyperlink.docx");
  const refusedRestorePath = join(dir, "refused-restored.docx");
  await writeFile(
    partialInputPath,
    hyperlinkDocx("Contact [EMAIL_ADDRESS_matter%5F1_1]"),
  );
  const refusedRestore = await run([
    "docx",
    "restore",
    "--session-archive",
    archivePath,
    "--session-key-file",
    keyPath,
    "--session-id",
    "matter_1",
    "--output",
    refusedRestorePath,
    partialInputPath,
  ]);
  expect(refusedRestore.code).toBe(1);
  expect(refusedRestore.err).toContain("fully supported restoration coverage");
  expect(await Bun.file(refusedRestorePath).exists()).toBeFalse();

  const restored = await run([
    "docx",
    "restore",
    "--session-archive",
    archivePath,
    "--session-key-file",
    keyPath,
    "--session-id",
    "matter_1",
    "--json",
    "--output",
    restoredPath,
    anonymizedPath,
  ]);
  expect(restored.code).toBe(0);
  expect(restored.out).not.toContain("person@example.test");
  expect(JSON.parse(restored.out)).toMatchObject({
    sessionId: "matter_1",
    restoredPlaceholderCount: 1,
    coverage: { status: "full" },
  });
  expect(extractDocxText(await readFile(restoredPath)).blocks.at(0)?.text).toBe(
    originalText,
  );

  const continuedRestoredPath = join(dir, "continued-restored.docx");
  const continuedRestored = await run([
    "docx",
    "restore",
    "--session-archive",
    archivePath,
    "--session-key-file",
    keyPath,
    "--session-id",
    "matter_1",
    "--output",
    continuedRestoredPath,
    continuedOutputPath,
  ]);
  expect(continuedRestored.code).toBe(0);
  expect(
    extractDocxText(await readFile(continuedRestoredPath)).blocks.at(0)?.text,
  ).toBe("Contact second@example.test");
});

test("DOCX create mode refuses an existing session archive before runtime setup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anonymize-cli-docx-"));
  const inputPath = join(dir, "input.docx");
  const outputPath = join(dir, "output.docx");
  const archivePath = join(dir, "session.stlasession");
  const keyPath = join(dir, "session.key");
  await writeFile(inputPath, docx("No sensitive text"));
  await writeFile(archivePath, "existing archive", "utf8");
  await writeFile(keyPath, new Uint8Array(32).fill(7));
  await chmod(keyPath, 0o600);

  const result = await run([
    "docx",
    "anonymize",
    "--session-mode",
    "create",
    "--session-archive",
    archivePath,
    "--session-key-file",
    keyPath,
    "--session-id",
    "matter_1",
    "--output",
    outputPath,
    inputPath,
  ]);
  expect(result.code).toBe(2);
  expect(result.err).toContain("refuses to overwrite");
  expect(await Bun.file(outputPath).exists()).toBeFalse();
});
