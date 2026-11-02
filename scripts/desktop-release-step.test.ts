import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DESKTOP_WINDOWS_DRY_RUN_INPUTS } from "./ci-plan-scope";
import {
  configureWindowsSigning,
  desktopArtifacts,
  locateWindowsSignTool,
  resignWindowsArtifacts,
  signWindowsArtifacts,
  stampCargoPackageVersion,
  stampDesktopRelease,
} from "./desktop-release-step";

const githubExpression = (body: string): string => `\${{ ${body} }}`;

const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release-desktop.yml", import.meta.url),
  "utf-8",
);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const temporary = (): string =>
  path.join(
    process.env["TMPDIR"] ?? "/tmp",
    `desktop-release-${crypto.randomUUID()}`,
  );

const releaseToolingViolations = (workflowSource: string): string[] => {
  const workflow = Bun.YAML.parse(workflowSource);
  if (!record(workflow) || !record(workflow["jobs"])) {
    return ["release workflow has no jobs"];
  }
  const violations: string[] = [];
  for (const [jobName, rawJob] of Object.entries(workflow["jobs"])) {
    const steps = record(rawJob) ? rawJob["steps"] : undefined;
    if (!Array.isArray(steps)) {
      continue;
    }
    const releaseCheckoutIndex = steps.findIndex((rawStep) => {
      if (!record(rawStep) || !record(rawStep["with"])) {
        return false;
      }
      return (
        rawStep["with"]["ref"] ===
        githubExpression("needs.resolve.outputs.release_sha")
      );
    });
    const toolingStepIndexes = steps.flatMap((rawStep, index) => {
      if (index <= releaseCheckoutIndex) {
        return [];
      }
      if (!record(rawStep)) {
        return [];
      }
      const run = typeof rawStep["run"] === "string" ? rawStep["run"] : "";
      const uses = typeof rawStep["uses"] === "string" ? rawStep["uses"] : "";
      return run.includes("desktop-release-step.ts") ||
        uses.includes("desktop-windows-build")
        ? [index]
        : [];
    });
    if (releaseCheckoutIndex === -1 || toolingStepIndexes.length === 0) {
      continue;
    }

    const beforeCheckout = steps.slice(0, releaseCheckoutIndex);
    const toolingCheckout = beforeCheckout.some((rawStep) => {
      if (!record(rawStep) || !record(rawStep["with"])) {
        return false;
      }
      const sparseCheckout = rawStep["with"]["sparse-checkout"];
      return (
        rawStep["with"]["ref"] === githubExpression("github.workflow_sha") &&
        typeof sparseCheckout === "string" &&
        sparseCheckout.includes("scripts/desktop-release-step.ts") &&
        sparseCheckout.includes(".github/actions/desktop-windows-build/")
      );
    });
    if (!toolingCheckout) {
      violations.push(`${jobName}: workflow tooling is not checked out`);
    }
    const preserved = beforeCheckout.some((rawStep) => {
      if (!record(rawStep) || typeof rawStep["run"] !== "string") {
        return false;
      }
      return (
        rawStep["run"].includes("$RUNNER_TEMP/release-tooling") &&
        rawStep["run"].includes("RELEASE_TOOLING=") &&
        rawStep["run"].includes("desktop-release-step.ts") &&
        rawStep["run"].includes("desktop-windows-build")
      );
    });
    if (!preserved) {
      violations.push(`${jobName}: tooling is not preserved before checkout`);
    }

    for (const index of toolingStepIndexes) {
      const rawStep = steps[index];
      if (!record(rawStep)) {
        continue;
      }
      const run = typeof rawStep["run"] === "string" ? rawStep["run"] : "";
      const uses = typeof rawStep["uses"] === "string" ? rawStep["uses"] : "";
      if (
        run.includes("desktop-release-step.ts") &&
        !run.includes("$RELEASE_TOOLING/scripts/desktop-release-step.ts")
      ) {
        violations.push(`${jobName}: script does not use preserved tooling`);
      }
      if (uses.includes("desktop-windows-build")) {
        const destination = uses.slice(2);
        const actionRestored = steps
          .slice(releaseCheckoutIndex + 1, index)
          .some(
            (candidate) =>
              record(candidate) &&
              typeof candidate["run"] === "string" &&
              candidate["run"].includes(`rm -rf ${destination}`) &&
              candidate["run"].includes(
                `cp -R "$RELEASE_TOOLING/actions/desktop-windows-build" ${destination}`,
              ),
          );
        if (!actionRestored) {
          violations.push(`${jobName}: action is not restored after checkout`);
        }
      }
    }
  }
  return violations;
};

test("release script steps follow source checkout and Bun setup", () => {
  const workflow = Bun.YAML.parse(releaseWorkflow);
  expect(record(workflow)).toBe(true);
  if (!record(workflow)) {
    return;
  }
  const jobs = workflow["jobs"];
  expect(record(jobs)).toBe(true);
  if (!record(jobs)) {
    return;
  }

  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const steps = record(rawJob) ? rawJob["steps"] : undefined;
    if (!Array.isArray(steps)) {
      continue;
    }
    let sourceCheckout = false;
    let bunSetup = false;
    for (const rawStep of steps) {
      if (!record(rawStep)) {
        continue;
      }
      const step = rawStep;
      const uses = step["uses"];
      const inputs = record(step["with"]) ? step["with"] : undefined;
      if (
        typeof uses === "string" &&
        uses.startsWith("actions/checkout@") &&
        inputs?.["path"] === undefined
      ) {
        sourceCheckout = true;
      }
      if (typeof uses === "string" && uses.startsWith("oven-sh/setup-bun@")) {
        bunSetup = true;
      }
      if (
        typeof step["run"] === "string" &&
        /\bbun\s+scripts\//u.test(step["run"])
      ) {
        expect(sourceCheckout, `${jobName}: ${String(step["name"])}`).toBe(
          true,
        );
        expect(bunSetup, `${jobName}: ${String(step["name"])}`).toBe(true);
      }
    }
  }
});

test("release jobs preserve workflow tooling before checking out release source", () => {
  expect(releaseToolingViolations(releaseWorkflow)).toEqual([]);

  const brokenWorkflow = releaseWorkflow
    .replace(
      'bun "$RELEASE_TOOLING/scripts/desktop-release-step.ts" stamp',
      "bun scripts/desktop-release-step.ts stamp",
    )
    .replace(
      'cp -R "$RELEASE_TOOLING/actions/desktop-windows-build" .github/actions/desktop-windows-build',
      "echo action restore omitted",
    );
  expect(releaseToolingViolations(brokenWorkflow)).toEqual([
    "build: script does not use preserved tooling",
    "build: action is not restored after checkout",
  ]);

  expect(
    releaseToolingViolations(
      releaseWorkflow.replace(
        "rm -rf .github/actions/desktop-windows-build",
        "echo cleanup omitted",
      ),
    ),
  ).toEqual(["build: action is not restored after checkout"]);
});

test("the preserved release script imports only Node built-ins", () => {
  const script = readFileSync(
    new URL("desktop-release-step.ts", import.meta.url),
    "utf-8",
  );
  const imports = [...script.matchAll(/from\s+["']([^"']+)["']/gu)].map(
    (match) => match[1],
  );
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(
    true,
  );
});

test("the Windows build action receives its release script path explicitly", () => {
  const action = readFileSync(
    new URL(
      "../.github/actions/desktop-windows-build/action.yml",
      import.meta.url,
    ),
    "utf-8",
  );
  const commands = action
    .split("\n")
    .filter((line) => line.includes("desktop-release-step.ts"));
  expect(commands).toEqual([
    "    description: Path to desktop-release-step.ts",
  ]);
  const invocations = [...action.matchAll(/^\s+run: bun "([^"]+)"/gmu)];
  expect(invocations.length).toBeGreaterThan(0);
  for (const invocation of invocations) {
    expect(invocation.at(1)).toBe(githubExpression("inputs.script-path"));
  }
  expect(action).not.toMatch(
    /bun (?:\.\.\/)*scripts\/desktop-release-step\.ts/u,
  );
});

test("stamps the version into both files and pins the channel endpoint", () => {
  const root = temporary();
  mkdirSync(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  writeFileSync(
    path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
    '{"version":"0.1.0","plugins":{"updater":{"endpoints":[]}}}',
  );
  writeFileSync(
    path.join(root, "apps/desktop/src-tauri/Cargo.toml"),
    '[package]\nname = "stella-desktop"\nversion = "0.1.0"\n',
  );
  writeFileSync(
    path.join(root, "apps/desktop/src-tauri/Cargo.lock"),
    '[[package]]\nname = "stella-desktop"\nversion = "0.1.0"\n',
  );
  stampDesktopRelease(root, "2.3.4", "beta");
  expect(
    readFileSync(
      path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf-8",
    ),
  ).toContain('"version": "2.3.4"');
  expect(
    readFileSync(
      path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf-8",
    ),
  ).toContain("/beta/latest.json");
  expect(
    readFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf-8"),
  ).toContain('version = "2.3.4"');
  expect(
    readFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf-8"),
  ).toBe('[[package]]\nname = "stella-desktop"\nversion = "2.3.4"\n');
});

const desktopCrate = new URL("../apps/desktop/src-tauri/", import.meta.url);

const changedLines = (before: string, after: string): string[] => {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  expect(afterLines).toHaveLength(beforeLines.length);
  return afterLines.filter((line, index) => line !== beforeLines[index]);
};

test("stamping the committed crate changes only its own version in the manifest and lockfile", () => {
  const crate = temporary();
  mkdirSync(crate, { recursive: true });
  const manifest = readFileSync(new URL("Cargo.toml", desktopCrate), "utf-8");
  const lock = readFileSync(new URL("Cargo.lock", desktopCrate), "utf-8");
  writeFileSync(path.join(crate, "Cargo.toml"), manifest);
  writeFileSync(path.join(crate, "Cargo.lock"), lock);

  stampCargoPackageVersion(crate, "0.0.0-dry.1");

  const stampedLock = readFileSync(path.join(crate, "Cargo.lock"), "utf-8");
  expect(
    changedLines(
      manifest,
      readFileSync(path.join(crate, "Cargo.toml"), "utf-8"),
    ),
  ).toEqual(['version = "0.0.0-dry.1"']);
  expect(changedLines(lock, stampedLock)).toEqual(['version = "0.0.0-dry.1"']);
  expect(stampedLock).toContain(
    '[[package]]\nname = "stella-desktop"\nversion = "0.0.0-dry.1"\n',
  );
});

test("stamping keeps CRLF checkouts consistent", () => {
  const crate = temporary();
  mkdirSync(crate, { recursive: true });
  writeFileSync(
    path.join(crate, "Cargo.toml"),
    '[package]\r\nname = "app"\r\nversion = "0.1.0"\r\n',
  );
  writeFileSync(
    path.join(crate, "Cargo.lock"),
    '[[package]]\r\nname = "app"\r\nversion = "0.1.0"\r\n\r\n[[package]]\r\nname = "app-dep"\r\nversion = "0.1.0"\r\n',
  );
  stampCargoPackageVersion(crate, "1.2.3");
  expect(readFileSync(path.join(crate, "Cargo.toml"), "utf-8")).toBe(
    '[package]\r\nname = "app"\r\nversion = "1.2.3"\r\n',
  );
  expect(readFileSync(path.join(crate, "Cargo.lock"), "utf-8")).toBe(
    '[[package]]\r\nname = "app"\r\nversion = "1.2.3"\r\n\r\n[[package]]\r\nname = "app-dep"\r\nversion = "0.1.0"\r\n',
  );
});

test("stamping writes nothing when the lockfile lacks the package entry", () => {
  const crate = temporary();
  mkdirSync(crate, { recursive: true });
  const manifest = '[package]\nname = "app"\nversion = "0.1.0"\n';
  const lock = '[[package]]\nname = "app"\nversion = "0.0.9"\n';
  writeFileSync(path.join(crate, "Cargo.toml"), manifest);
  writeFileSync(path.join(crate, "Cargo.lock"), lock);
  expect(() => stampCargoPackageVersion(crate, "1.2.3")).toThrow(
    "Expected exactly one Cargo.lock entry for app 0.1.0, found 0",
  );
  expect(readFileSync(path.join(crate, "Cargo.toml"), "utf-8")).toBe(manifest);
  expect(readFileSync(path.join(crate, "Cargo.lock"), "utf-8")).toBe(lock);
});

test("resigning skips an absent updater zip", () => {
  const bundle = temporary();
  mkdirSync(path.join(bundle, "nsis"), { recursive: true });
  writeFileSync(path.join(bundle, "nsis/Stella-setup.exe"), "installer");
  const signed: string[] = [];
  resignWindowsArtifacts({
    bundleDir: bundle,
    appVersion: "1.2.3",
    run: ({ file }) => {
      signed.push(file);
    },
  });
  expect(signed).toEqual(["Stella-setup.exe"]);
});

test("resigning binds every updater signature to the stamped version", () => {
  const bundle = temporary();
  mkdirSync(path.join(bundle, "nsis"), { recursive: true });
  writeFileSync(path.join(bundle, "nsis/Stella-setup.exe"), "installer");
  writeFileSync(path.join(bundle, "nsis/Stella-setup.exe.zip"), "update");
  const versions: string[] = [];
  resignWindowsArtifacts({
    bundleDir: bundle,
    appVersion: "1.2.3",
    run: ({ appVersion }) => {
      versions.push(appVersion);
    },
  });
  expect(versions).toEqual(["1.2.3", "1.2.3"]);
});

test("resigning rejects an empty artifact directory", () => {
  const bundle = temporary();
  mkdirSync(bundle, { recursive: true });
  expect(() =>
    resignWindowsArtifacts({
      bundleDir: bundle,
      appVersion: "1.2.3",
      run: () => undefined,
    }),
  ).toThrow("No Windows installers found");
});

test("configure-windows rejects unknown modes", () => {
  const config = path.join(temporary(), "tauri.conf.json");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, '{"bundle":{"windows":{}}}');
  expect(() => configureWindowsSigning(config, "other", {})).toThrow(
    "Unknown configure-windows mode",
  );
});

test("configure-windows dry-run disables signing and updater artifacts", () => {
  const config = path.join(temporary(), "tauri.conf.json");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(
    config,
    readFileSync(
      new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url),
      "utf-8",
    ),
  );
  configureWindowsSigning(config, "dry-run", {});
  const result = JSON.parse(readFileSync(config, "utf-8"));
  expect(result.bundle.windows.signCommand).toBeUndefined();
  expect(result.bundle.createUpdaterArtifacts).toBe(false);
});

test("the CI dry-run selector covers every script the release build runs", () => {
  const windowsBuild = readFileSync(
    new URL(
      "../.github/actions/desktop-windows-build/action.yml",
      import.meta.url,
    ),
    "utf-8",
  );
  const references = [
    ...`${releaseWorkflow}\n${windowsBuild}`.matchAll(
      /\b(scripts\/[\w-]+(?:\.[\w-]+)*\.(?:sh|ts))\b/gu,
    ),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  expect(references.length).toBeGreaterThan(0);
  const patterns = [...DESKTOP_WINDOWS_DRY_RUN_INPUTS];
  expect(patterns).not.toContain("scripts/*");
  for (const reference of new Set(references)) {
    expect(
      patterns.some((pattern) => new Bun.Glob(pattern).match(reference)),
      reference,
    ).toBe(true);
  }
});

test("artifact discovery is recursive, stable, and rejects unrelated files", () => {
  const bundle = temporary();
  mkdirSync(path.join(bundle, "nsis"), { recursive: true });
  writeFileSync(path.join(bundle, "nsis/Stella-windows.exe"), "installer");
  writeFileSync(path.join(bundle, "Stella-macos.dmg"), "installer");
  writeFileSync(path.join(bundle, "latest.json"), "{}");
  expect(desktopArtifacts(bundle)).toEqual([
    path.join(bundle, "Stella-macos.dmg"),
    path.join(bundle, "nsis/Stella-windows.exe"),
  ]);
  expect(desktopArtifacts(path.join(bundle, "missing"))).toEqual([]);
});

test("Windows signing finds the newest installed SDK numerically", () => {
  const programFiles = temporary();
  const sdk = path.join(programFiles, "Windows Kits", "10", "bin");
  for (const version of ["10.0.9.0", "10.0.10.0"]) {
    mkdirSync(path.join(sdk, version, "x64"), { recursive: true });
    writeFileSync(path.join(sdk, version, "x64/signtool.exe"), "fixture");
  }
  mkdirSync(path.join(sdk, "10.0.11.0"));
  expect(locateWindowsSignTool(programFiles)).toBe(
    path.join(sdk, "10.0.10.0", "x64/signtool.exe"),
  );
});

test("Windows signing refuses an SDK without signtool", () => {
  const programFiles = temporary();
  mkdirSync(path.join(programFiles, "Windows Kits", "10", "bin"), {
    recursive: true,
  });
  expect(() => locateWindowsSignTool(programFiles)).toThrow(
    "signtool.exe not found",
  );
});

const signingEnv = {
  AZURE_TENANT_ID: "fixture-tenant",
  AZURE_CLIENT_ID: "fixture-client",
  AZURE_CLIENT_SECRET: "fixture-credential",
  AZURE_ENDPOINT: "https://signing.example",
  AZURE_CODE_SIGNING_ACCOUNT: "fixture-account",
  AZURE_CERT_PROFILE: "fixture-profile",
  SIGNTOOL_PATH: "fixture-signtool",
};

test("desktop and standalone executables use the same trusted signing arguments", () => {
  const directory = temporary();
  mkdirSync(path.join(directory, "nsis"), { recursive: true });
  const native = path.join(directory, "stella-windows-x64.exe");
  const desktop = path.join(directory, "nsis/Stella-setup.exe");
  writeFileSync(native, "native");
  writeFileSync(desktop, "desktop");
  writeFileSync(path.join(directory, "installer.exe.zip"), "archive");
  const commands: string[][] = [];
  signWindowsArtifacts({
    directory,
    env: signingEnv,
    run: (command) => {
      commands.push(command);
      return 0;
    },
  });
  expect(commands).toEqual(
    [desktop, native]
      .toSorted()
      .map((file) => [
        "trusted-signing-cli",
        "-e",
        signingEnv.AZURE_ENDPOINT,
        "-a",
        signingEnv.AZURE_CODE_SIGNING_ACCOUNT,
        "-c",
        signingEnv.AZURE_CERT_PROFILE,
        file,
      ]),
  );
  expect(commands.flat()).not.toContain(signingEnv.AZURE_CLIENT_SECRET);
});

test("Windows signing fails before dispatch without credentials and stops on signer failure", () => {
  const directory = temporary();
  mkdirSync(directory);
  writeFileSync(path.join(directory, "stella.exe"), "fixture");
  let calls = 0;
  const run = () => {
    calls += 1;
    return 1;
  };
  expect(() =>
    signWindowsArtifacts({
      directory,
      env: { ...signingEnv, AZURE_CLIENT_SECRET: "" },
      run,
    }),
  ).toThrow("Missing AZURE_CLIENT_SECRET");
  expect(calls).toBe(0);
  expect(() =>
    signWindowsArtifacts({ directory, env: signingEnv, run }),
  ).toThrow("Windows executable signing failed");
  expect(calls).toBe(1);
});

test("release signing actions keep Azure credentials out of third-party action steps", () => {
  const nativeSource = readFileSync(
    new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    "utf-8",
  );
  const desktopSource = readFileSync(
    new URL(
      "../.github/actions/desktop-windows-build/action.yml",
      import.meta.url,
    ),
    "utf-8",
  );
  for (const source of [nativeSource, desktopSource]) {
    expect(source).not.toContain("azure/trusted-signing-action@");
    if (source === desktopSource) {
      expect(source).toContain(" sign-windows ");
    } else {
      expect(source).toContain(
        "& trusted-signing-cli -e $env:AZURE_ENDPOINT -a $env:AZURE_CODE_SIGNING_ACCOUNT -c $env:AZURE_CERT_PROFILE $executable.FullName",
      );
    }
    const document: unknown = Bun.YAML.parse(source);
    if (!record(document)) {
      throw new TypeError("Expected signing workflow mapping");
    }
    const groups = record(document["jobs"])
      ? Object.values(document["jobs"])
      : [document["runs"]];
    for (const group of groups) {
      if (!record(group) || !Array.isArray(group["steps"])) {
        continue;
      }
      for (const step of group["steps"]) {
        if (
          !record(step) ||
          typeof step["uses"] !== "string" ||
          step["uses"].startsWith("./")
        ) {
          continue;
        }
        expect(JSON.stringify(step["with"] ?? {})).not.toMatch(/AZURE_/u);
        const inheritedEnv = record(group["env"]) ? group["env"] : {};
        const stepEnv = record(step["env"]) ? step["env"] : {};
        for (const [name, value] of Object.entries({
          ...inheritedEnv,
          ...stepEnv,
        })) {
          if (name.startsWith("AZURE_")) {
            expect(value).toBe("");
          }
          expect(String(value)).not.toMatch(/secrets\.AZURE_/u);
        }
        if (
          step["uses"].startsWith("baptiste0928/cargo-install@") &&
          !record(document["jobs"])
        ) {
          expect(step["env"]).toMatchObject({
            AZURE_TENANT_ID: "",
            AZURE_CLIENT_ID: "",
            AZURE_CLIENT_SECRET: "",
          });
        }
      }
    }
  }
});

const expectWindowsSignatureChecks = (script: string): void => {
  expect(script).toContain('$ErrorActionPreference = "Stop"');
  expect(script).toContain("-Filter *.exe -File -Recurse -ErrorAction Stop");
  expect(script).toMatch(/if \(\$executables\.Count -eq 0\)\s*\{\s*throw/u);
  expect(script).toContain("foreach ($executable in $executables)");
  expect(script).toContain(
    "Get-AuthenticodeSignature -LiteralPath $executable.FullName -ErrorAction Stop",
  );
  expect(script).toMatch(
    /if \(\$signature\.Status -ne "Valid"\)\s*\{\s*throw/u,
  );
  expect(script).toMatch(
    /if \(\$null -eq \$signature\.TimeStamperCertificate\)\s*\{\s*throw/u,
  );
};

const readNativeReleaseJobs = (): Record<string, unknown> => {
  const source = readFileSync(
    new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    "utf-8",
  );
  const workflow: unknown = Bun.YAML.parse(source);
  if (!record(workflow) || !record(workflow["jobs"])) {
    throw new TypeError("Expected native CLI release workflow jobs");
  }
  return workflow["jobs"];
};

test("desktop executables pass signature and timestamp verification before updater signing", () => {
  const source = readFileSync(
    new URL(
      "../.github/actions/desktop-windows-build/action.yml",
      import.meta.url,
    ),
    "utf-8",
  );
  const action: unknown = Bun.YAML.parse(source);
  if (!record(action) || !record(action["runs"])) {
    throw new TypeError("Expected Windows build composite action");
  }
  const steps = action["runs"]["steps"];
  if (!Array.isArray(steps)) {
    throw new TypeError("Expected Windows build steps");
  }
  const signIndex = steps.findIndex(
    (step) =>
      record(step) &&
      typeof step["run"] === "string" &&
      step["run"].includes(" sign-windows "),
  );
  const verifyIndex = steps.findIndex(
    (step) =>
      record(step) &&
      step["name"] === "Verify Windows signatures and timestamps",
  );
  const updaterIndex = steps.findIndex(
    (step) =>
      record(step) &&
      typeof step["run"] === "string" &&
      step["run"].includes(" resign "),
  );
  expect(signIndex).toBeGreaterThanOrEqual(0);
  expect(verifyIndex).toBeGreaterThan(signIndex);
  expect(updaterIndex).toBeGreaterThan(verifyIndex);
  const verify = steps.at(verifyIndex);
  if (!record(verify) || typeof verify["run"] !== "string") {
    throw new TypeError("Expected signature verification script");
  }
  expect(verify["shell"]).toBe("pwsh");
  expect(verify["if"]).toBe("inputs.dry-run != 'true'");
  expect(verify["env"]).toMatchObject({
    AZURE_TENANT_ID: "",
    AZURE_CLIENT_ID: "",
    AZURE_CLIENT_SECRET: "",
    TAURI_SIGNING_PRIVATE_KEY: "",
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  });
  expectWindowsSignatureChecks(verify["run"]);
});

test("native executables pass signature and timestamp verification before artifact upload", () => {
  const signJob = readNativeReleaseJobs()["cli-native-sign"];
  if (!record(signJob) || !Array.isArray(signJob["steps"])) {
    throw new TypeError("Expected native CLI signing steps");
  }
  const steps = signJob["steps"];
  const signIndex = steps.findIndex(
    (step) =>
      record(step) &&
      step["name"] === "Sign Windows CLI with desktop signing mechanism",
  );
  const verifyIndex = steps.findIndex(
    (step) =>
      record(step) &&
      step["name"] === "Verify Windows signatures and timestamps",
  );
  const uploadIndex = steps.findIndex(
    (step) => record(step) && step["name"] === "Upload verified standalone CLI",
  );
  expect(signIndex).toBeGreaterThanOrEqual(0);
  expect(verifyIndex).toBeGreaterThan(signIndex);
  expect(uploadIndex).toBeGreaterThan(verifyIndex);
  const verify = steps.at(verifyIndex);
  if (!record(verify) || typeof verify["run"] !== "string") {
    throw new TypeError(
      "Expected native Windows signature verification script",
    );
  }
  expect(verify["shell"]).toBe("bash");
  expect(verify["if"]).toBe("matrix.platform == 'windows-x64'");
  expect(verify["run"]).toContain("pwsh -NoProfile -NonInteractive -Command -");
  expect(verify["env"]).toEqual({ SIGNED_ARTIFACT_DIRECTORY: "native-cli" });
  expectWindowsSignatureChecks(verify["run"]);
});

test("native compilation and signing run in separate jobs without source execution near signing keys", () => {
  const jobs = readNativeReleaseJobs();
  const build = jobs["cli-native-build"];
  const sign = jobs["cli-native-sign"];
  if (!record(build) || !record(sign) || !Array.isArray(sign["steps"])) {
    throw new TypeError("Expected separate native build and signing jobs");
  }
  expect(JSON.stringify(build)).not.toMatch(/secrets\./u);
  expect(build["permissions"]).toEqual({ contents: "read" });
  expect(sign["needs"]).toBe("cli-native-build");
  expect(sign["permissions"]).toEqual({});
  expect(sign["env"]).toBeUndefined();
  for (const step of sign["steps"]) {
    if (!record(step)) {
      throw new TypeError("Expected native signing step mapping");
    }
    if (typeof step["uses"] === "string") {
      expect(step["uses"]).not.toMatch(
        /(?:actions\/checkout|setup-bun|^\.\/)/u,
      );
    }
    if (typeof step["run"] === "string") {
      expect(step["run"]).not.toMatch(/\bbun\s|codegen|(?:^|[\s"'])scripts\//u);
    }
  }
});

test("native release provenance covers final binaries and checksums before publication", () => {
  const upload = readNativeReleaseJobs()["cli-native-upload"];
  if (!record(upload) || !Array.isArray(upload["steps"])) {
    throw new TypeError("Expected native release upload job");
  }
  expect(upload["needs"]).toEqual(["pack", "release-cli", "cli-native-sign"]);
  expect(upload["permissions"]).toEqual({
    actions: "read",
    contents: "write",
    "id-token": "write",
    attestations: "write",
  });
  const steps = upload["steps"];
  const hashIndex = steps.findIndex(
    (step) =>
      record(step) &&
      typeof step["run"] === "string" &&
      step["run"].includes(`sha256sum "\${assets[@]}" > checksums.txt`),
  );
  const attestIndex = steps.findIndex(
    (step) =>
      record(step) &&
      typeof step["uses"] === "string" &&
      step["uses"] === "./.github/actions/provenance",
  );
  const publishIndex = steps.findIndex(
    (step) =>
      record(step) &&
      typeof step["run"] === "string" &&
      step["run"].includes(
        'bash scripts/upload-release-assets.sh "$GITHUB_REPOSITORY" "$CLI_RELEASE_REF" native-cli/*',
      ),
  );
  expect(hashIndex).toBeGreaterThanOrEqual(0);
  expect(attestIndex).toBeGreaterThan(hashIndex);
  expect(publishIndex).toBeGreaterThan(attestIndex);
  const attestation = steps.at(attestIndex);
  if (!record(attestation) || !record(attestation["with"])) {
    throw new TypeError("Expected release provenance subjects");
  }
  expect(attestation["uses"]).toBe("./.github/actions/provenance");
  expect(attestation["with"]["subject-path"]).toBe("native-cli/*");
  const hashes = steps.at(hashIndex);
  if (!record(hashes) || typeof hashes["run"] !== "string") {
    throw new TypeError("Expected release checksum creation");
  }
  expect(hashes["run"]).toContain(
    "assets=(stella-darwin-arm64 stella-darwin-x64 stella-linux-x64 stella-linux-arm64 stella-windows-x64.exe)",
  );
});
