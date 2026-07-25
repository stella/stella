import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "stella-mcp-pack-")),
);
const repositoryRoot = await realpath(
  join(import.meta.dirname, "..", "..", ".."),
);
const runtimePackageFiles = [
  "packages/anonymize/package.json",
  "packages/anonymize-darwin-arm64/package.json",
  "packages/anonymize-darwin-x64/package.json",
  "packages/anonymize-linux-arm64-gnu/package.json",
  "packages/anonymize-linux-x64-gnu/package.json",
  "packages/anonymize-win32-x64-msvc/package.json",
  "packages/anonymize/wasm/package.json",
  "packages/cli/package.json",
  "packages/document-pdf/package.json",
];

const packPackage = async (directory, destination) => {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", destination],
    { cwd: directory },
  );
  const filename = JSON.parse(stdout).at(0)?.filename;
  if (typeof filename !== "string") {
    throw new Error("npm pack did not report an archive filename");
  }
  return join(destination, filename);
};

const platformPackageDirectory = () => {
  const key = `${process.platform}-${process.arch}`;
  const packages = {
    "darwin-arm64": "anonymize-darwin-arm64",
    "darwin-x64": "anonymize-darwin-x64",
    "linux-arm64": "anonymize-linux-arm64-gnu",
    "linux-x64": "anonymize-linux-x64-gnu",
    "win32-x64": "anonymize-win32-x64-msvc",
  };
  const directory = packages[key];
  if (directory === undefined) {
    throw new Error(`Unsupported packed-smoke platform: ${key}`);
  }
  return join(repositoryRoot, "packages", directory);
};

const preparePlatformPackage = async (destination) => {
  const nativeBinding = "stella_anonymize_napi.node";
  const cachedNativeBinding = join(
    repositoryRoot,
    "packages",
    "anonymize",
    nativeBinding,
  );
  await access(cachedNativeBinding).catch(() => {
    throw new Error(
      `Canonical native binding is missing: ${cachedNativeBinding}. Build @stll/anonymize before running the packed MCP smoke test.`,
    );
  });
  await cp(platformPackageDirectory(), destination, {
    filter: (source) =>
      basename(source) !== "node_modules" && basename(source) !== nativeBinding,
    recursive: true,
  });
  await cp(cachedNativeBinding, join(destination, nativeBinding));
};

const prepareCargoWorkspace = async (destination) => {
  const { stdout } = await execFileAsync(
    "cargo",
    ["metadata", "--no-deps", "--locked", "--format-version", "1"],
    { cwd: repositoryRoot },
  );
  const metadata = JSON.parse(stdout);
  const workspaceMembers = new Set(metadata.workspace_members);
  for (const cargoPackage of metadata.packages) {
    if (!workspaceMembers.has(cargoPackage.id)) {
      continue;
    }
    const packageFiles = new Set([
      cargoPackage.manifest_path,
      ...cargoPackage.targets.map((target) => target.src_path),
    ]);
    for (const source of packageFiles) {
      const canonicalSource = await realpath(source);
      const repositoryRelative = relative(repositoryRoot, canonicalSource);
      if (
        isAbsolute(repositoryRelative) ||
        repositoryRelative === ".." ||
        repositoryRelative.startsWith(`..${sep}`)
      ) {
        throw new Error(
          `Cargo workspace file escapes the repository: ${canonicalSource}`,
        );
      }
      const target = join(destination, repositoryRelative);
      await mkdir(dirname(target), { recursive: true });
      await cp(canonicalSource, target);
    }
  }
};

try {
  const coreArchive = await packPackage(
    join(repositoryRoot, "packages", "anonymize"),
    temporary,
  );
  const packedPlatformPackage = join(temporary, "platform-package");
  await preparePlatformPackage(packedPlatformPackage);
  const platformArchive = await packPackage(packedPlatformPackage, temporary);
  const releaseWorkspace = join(temporary, "release-workspace");
  const releasePacks = join(temporary, "release-packs");
  await mkdir(releaseWorkspace);
  await mkdir(releasePacks);
  for (const file of ["VERSION", "Cargo.toml", "Cargo.lock", "bun.lock"]) {
    await cp(join(repositoryRoot, file), join(releaseWorkspace, file));
  }
  await prepareCargoWorkspace(releaseWorkspace);
  const pythonManifest = "crates/anonymize-py/pyproject.toml";
  await mkdir(dirname(join(releaseWorkspace, pythonManifest)), {
    recursive: true,
  });
  await cp(
    join(repositoryRoot, pythonManifest),
    join(releaseWorkspace, pythonManifest),
  );
  for (const file of runtimePackageFiles) {
    await mkdir(dirname(join(releaseWorkspace, file)), { recursive: true });
    await cp(join(repositoryRoot, file), join(releaseWorkspace, file));
  }
  for (const packageDirectory of ["document-docx", "document-pdf"]) {
    await cp(
      join(repositoryRoot, "packages", packageDirectory),
      join(releaseWorkspace, "packages", packageDirectory),
      {
        filter: (source) => basename(source) !== "node_modules",
        recursive: true,
      },
    );
  }
  await cp(
    join(repositoryRoot, "packages", "mcp"),
    join(releaseWorkspace, "packages", "mcp"),
    { recursive: true },
  );
  await execFileAsync(
    process.execPath,
    [
      join(repositoryRoot, ".github", "tools", "sync-runtime-version.mjs"),
      "--release",
    ],
    { cwd: releaseWorkspace },
  );
  await execFileAsync(
    process.execPath,
    [
      join(repositoryRoot, ".github", "tools", "sync-runtime-version.mjs"),
      "--release",
      "--check",
    ],
    { cwd: releaseWorkspace },
  );
  const releaseManifestPath = join(
    releaseWorkspace,
    "packages",
    "mcp",
    "package.json",
  );
  const releaseManifest = JSON.parse(
    await readFile(releaseManifestPath, "utf8"),
  );
  const coreManifest = JSON.parse(
    await readFile(
      join(repositoryRoot, "packages", "anonymize", "package.json"),
      "utf8",
    ),
  );
  if (
    releaseManifest.dependencies?.["@stll/anonymize"] !==
      coreManifest.version ||
    releaseManifest.dependencies?.["@stll/anonymize-pdf"] !==
      coreManifest.version
  ) {
    throw new Error(
      "Release sync did not resolve the exact MCP co-release dependencies",
    );
  }
  const releaseDocxArchive = await packPackage(
    join(releaseWorkspace, "packages", "document-docx"),
    releasePacks,
  );
  const releasePdfArchive = await packPackage(
    join(releaseWorkspace, "packages", "document-pdf"),
    releasePacks,
  );
  const releaseMcpArchive = await packPackage(
    join(releaseWorkspace, "packages", "mcp"),
    releasePacks,
  );
  const { stdout: packedManifestJson } = await execFileAsync("tar", [
    "-xOf",
    releaseMcpArchive,
    "package/package.json",
  ]);
  const packedManifest = JSON.parse(packedManifestJson);
  if (
    packedManifest.dependencies?.["@stll/anonymize"] !== coreManifest.version ||
    packedManifest.dependencies?.["@stll/anonymize-pdf"] !==
      coreManifest.version
  ) {
    throw new Error(
      "Packed MCP release did not resolve the exact co-release dependency",
    );
  }
  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await execFileAsync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      platformArchive,
      coreArchive,
      releaseDocxArchive,
      releasePdfArchive,
      releaseMcpArchive,
    ],
    { cwd: consumer },
  );
  const manifest = JSON.parse(
    await readFile(
      join(consumer, "node_modules", "@stll", "anonymize-mcp", "package.json"),
      "utf8",
    ),
  );
  if (manifest.bin?.["stella-anonymize-mcp"] !== "./dist/server-entry.mjs") {
    throw new Error(
      "Packed MCP bin does not target the dedicated entry module",
    );
  }
  const bin = join(consumer, "node_modules", ".bin", "stella-anonymize-mcp");

  const help = await execFileAsync(bin, ["--help"]);
  if (!help.stdout.includes("Usage: stella-anonymize-mcp")) {
    throw new Error("Packed symlinked MCP bin did not print help");
  }
  const startup = await execFileAsync(bin, []).catch((error) => error);
  if (
    typeof startup !== "object" ||
    startup === null ||
    !("stderr" in startup) ||
    typeof startup.stderr !== "string" ||
    !startup.stderr.includes("At least one --root directory is required")
  ) {
    throw new Error(
      "Packed symlinked MCP bin did not execute startup validation",
    );
  }

  const root = join(temporary, "root");
  const sessionDirectory = join(temporary, "sessions");
  const keyFile = join(temporary, "session.key");
  await mkdir(root, { mode: 0o700 });
  await mkdir(sessionDirectory, { mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(sessionDirectory, 0o700);
  await writeFile(keyFile, Buffer.alloc(32, 0x42), { mode: 0o600 });
  const server = spawn(
    bin,
    ["--root", root, "--session-dir", sessionDirectory, "--key-file", keyFile],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let serverStderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    serverStderr += chunk;
  });
  let serverStdout = "";
  const responses = new Map();
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    serverStdout += chunk;
    for (;;) {
      const newline = serverStdout.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = serverStdout.slice(0, newline);
      serverStdout = serverStdout.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        responses.get(message.id)?.(message);
        responses.delete(message.id);
      }
    }
  });
  const send = (message) => {
    server.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = async (message) => {
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new Error(`Timed out waiting for MCP response ${message.id}`)),
        10_000,
      );
      responses.set(message.id, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    send(message);
    return response;
  };
  const serverExit = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  const startupResult = await Promise.race([
    serverExit,
    new Promise((resolve) => setTimeout(() => resolve("running"), 500)),
  ]);
  if (startupResult !== "running") {
    throw new Error(
      `Packed durable MCP server exited during startup: ${startupResult.code ?? startupResult.signal}\n${serverStderr}`,
    );
  }
  const initialization = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "packed-smoke", version: "1.0.0" },
    },
  });
  if (initialization.error !== undefined) {
    throw new Error(
      `Packed MCP initialization failed: ${initialization.error.code}`,
    );
  }
  send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  const document = Buffer.from("XQZ-秘密 signed.", "utf8");
  const input = join(root, "external-input.txt");
  const batch = join(root, "external-batch.json");
  const output = join(root, "external-output.txt");
  await writeFile(input, document);
  await writeFile(
    batch,
    JSON.stringify({
      version: 1,
      document: {
        sha256: createHash("sha256").update(document).digest("hex"),
      },
      offsetUnit: "unicode-code-point",
      provider: { id: "packed-fake", name: "Packed fake", version: "1" },
      labelMap: [{ providerLabel: "PER", entityLabel: "person" }],
      detections: [
        { id: "packed-1", start: 0, end: 6, label: "PER", score: 0.99 },
      ],
    }),
  );
  const external = await request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "anonymize_text_file_with_external_detections",
      arguments: {
        inputPath: input,
        detectionBatchPath: batch,
        outputPath: output,
        sessionId: "packed_external_1",
      },
    },
  });
  if (
    external.error !== undefined ||
    external.result?.isError === true ||
    external.result?.structuredContent?.externalDetectionBatchStatus !==
      "accepted"
  ) {
    throw new Error("Packed MCP external-detection invocation failed");
  }
  if ((await readFile(output, "utf8")).includes("XQZ-秘密")) {
    throw new Error("Packed MCP external-detection invocation did not redact");
  }
  server.kill("SIGTERM");
  const shutdown = await serverExit;
  if (shutdown.code !== 0 || shutdown.signal !== null) {
    throw new Error(
      `Packed MCP server did not shut down gracefully: ${shutdown.code ?? shutdown.signal}\n${serverStderr}`,
    );
  }
} finally {
  await rm(temporary, { force: true, recursive: true });
}
