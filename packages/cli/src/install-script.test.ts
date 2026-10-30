import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sha256Hex } from "./sha256.js";

const INSTALL_SCRIPT = fileURLToPath(
  new URL("../../../apps/landing/public/install.sh", import.meta.url),
);
const POWERSHELL_SCRIPT = fileURLToPath(
  new URL("../../../apps/landing/public/install.ps1", import.meta.url),
);
const PAYLOAD = "#!/bin/sh\nprintf 'fixture\\n'\n";

type FixtureOptions = {
  readonly platform?: string;
  readonly arch?: string;
  readonly shell?: string;
  readonly onPath?: boolean;
  readonly noModifyPath?: boolean;
  readonly version?: string;
  readonly mismatch?: boolean;
  readonly customInstallDir?: boolean;
};

async function withInstaller(
  options: FixtureOptions,
  check: (fixture: {
    readonly home: string;
    readonly installDir: string;
    readonly run: () => ReturnType<typeof Bun.spawnSync>;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-install-"));
  try {
    const home = path.join(root, "home");
    const installDir = path.join(
      home,
      options.customInstallDir ? "custom install" : ".local/bin",
    );
    const commands = path.join(root, "commands");
    await mkdir(home);
    await mkdir(commands);
    const platform = options.platform ?? "Linux";
    const arch = options.arch ?? "x86_64";
    const asset = `stella-${platform === "Darwin" ? "darwin" : "linux"}-${arch === "aarch64" || arch === "arm64" ? "arm64" : "x64"}`;
    const releases = path.join(root, "releases");
    const release = path.join(
      releases,
      options.version ? `download/v${options.version}` : "latest/download",
    );
    await mkdir(release, { recursive: true });
    await writeFile(path.join(release, asset), PAYLOAD);
    const checksum = options.mismatch ? "0".repeat(64) : sha256Hex(PAYLOAD);
    await writeFile(
      path.join(release, "checksums.txt"),
      `${checksum}  ${asset}\n`,
    );
    await writeFile(
      path.join(commands, "uname"),
      `#!/bin/sh\ncase "$1" in -s) printf '${platform}\\n';; -m) printf '${arch}\\n';; esac\n`,
      { mode: 0o755 },
    );
    const run = () =>
      Bun.spawnSync({
        cmd: ["/bin/sh", INSTALL_SCRIPT],
        env: {
          HOME: home,
          PATH: `${options.onPath ? `${installDir}:` : ""}${commands}:/usr/bin:/bin`,
          SHELL: options.shell ?? "/bin/bash",
          XDG_CONFIG_HOME: path.join(home, ".config"),
          STELLA_INSTALL_TEST: "1",
          STELLA_RELEASE_BASE_URL: pathToFileURL(releases).href,
          STELLA_NO_MODIFY_PATH: options.noModifyPath ? "1" : "0",
          ...(options.customInstallDir
            ? { STELLA_INSTALL_DIR: installDir }
            : {}),
          ...(options.version ? { STELLA_VERSION: options.version } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    await check({ home, installDir, run });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("native install script", () => {
  for (const platform of ["Linux", "Darwin"]) {
    for (const arch of ["x86_64", "aarch64", "arm64"]) {
      test(`selects the ${platform} ${arch} binary and records its channel`, async () => {
        await withInstaller(
          { platform, arch },
          async ({ home, installDir, run }) => {
            const result = run();
            expect(result.stderr.toString()).toBe("");
            expect(result.exitCode).toBe(0);
            expect(
              await readFile(path.join(installDir, "stella"), "utf-8"),
            ).toBe(PAYLOAD);
            expect(
              (await stat(path.join(installDir, "stella"))).mode % 512,
            ).toBe(0o755);
            expect(
              await readFile(
                path.join(home, ".config/stella/install-channel"),
                "utf-8",
              ),
            ).toBe("native\n");
            expect(
              await readFile(
                path.join(home, ".config/stella/install-path"),
                "utf-8",
              ),
            ).toBe(`${path.join(installDir, "stella")}\n`);
            expect(result.stdout.toString()).toContain("stella auth login");
          },
        );
      });
    }
  }
  test("checksum mismatch refuses without installing or recording a channel", async () => {
    await withInstaller(
      { mismatch: true },
      async ({ home, installDir, run }) => {
        const result = run();
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain("Checksum mismatch");
        expect(await Bun.file(path.join(installDir, "stella")).exists()).toBe(
          false,
        );
        expect(
          await Bun.file(
            path.join(home, ".config/stella/install-channel"),
          ).exists(),
        ).toBe(false);
        expect(
          await Bun.file(
            path.join(home, ".config/stella/install-path"),
          ).exists(),
        ).toBe(false);
      },
    );
  });
  test("preserves the installed binary on checksum mismatch", async () => {
    await withInstaller({ mismatch: true }, async ({ installDir, run }) => {
      await mkdir(installDir, { recursive: true });
      await writeFile(path.join(installDir, "stella"), "existing");
      expect(run().exitCode).toBe(1);
      expect(await readFile(path.join(installDir, "stella"), "utf-8")).toBe(
        "existing",
      );
    });
  });
  for (const { shell, profile, platform } of [
    { shell: "/bin/zsh", profile: ".zshrc", platform: "Darwin" },
    { shell: "/bin/bash", profile: ".bashrc", platform: "Linux" },
    { shell: "/bin/bash", profile: ".bash_profile", platform: "Darwin" },
    {
      shell: "/usr/bin/fish",
      profile: ".config/fish/conf.d/stella.fish",
      platform: "Linux",
    },
  ]) {
    test(`adds exactly one PATH line to ${profile} across repeated installs`, async () => {
      await withInstaller({ shell, platform }, async ({ home, run }) => {
        expect(run().exitCode).toBe(0);
        expect(run().exitCode).toBe(0);
        const contents = await readFile(path.join(home, profile), "utf-8");
        expect(
          contents.split("\n").filter((line) => line.includes("# stella PATH")),
        ).toHaveLength(1);
      });
    });
    test(`leaves ${profile} untouched when the directory is on PATH`, async () => {
      await withInstaller(
        { shell, platform, onPath: true },
        async ({ home, run }) => {
          expect(run().exitCode).toBe(0);
          expect(await Bun.file(path.join(home, profile)).exists()).toBe(false);
        },
      );
    });
  }
  test("prints the profile line without editing when PATH modification is disabled", async () => {
    await withInstaller({ noModifyPath: true }, async ({ home, run }) => {
      const result = run();
      expect(result.exitCode).toBe(0);
      expect(await Bun.file(path.join(home, ".bashrc")).exists()).toBe(false);
      expect(result.stdout.toString()).toContain("# stella PATH");
    });
  });
  test("uses the pinned version instead of latest", async () => {
    await withInstaller({ version: "6.2.0" }, async ({ run }) => {
      expect(run().exitCode).toBe(0);
    });
  });
  test("installs to the overridden directory", async () => {
    await withInstaller(
      { customInstallDir: true },
      async ({ home, installDir, run }) => {
        expect(run().exitCode).toBe(0);
        expect(await readFile(path.join(installDir, "stella"), "utf-8")).toBe(
          PAYLOAD,
        );
        expect(await readFile(path.join(home, ".bashrc"), "utf-8")).toContain(
          installDir,
        );
        expect(
          await readFile(
            path.join(home, ".config/stella/install-path"),
            "utf-8",
          ),
        ).toBe(`${path.join(installDir, "stella")}\n`);
      },
    );
  });
  test("requires no privilege elevation and enforces verified transport", async () => {
    const script = await readFile(INSTALL_SCRIPT, "utf-8");
    expect(script).not.toMatch(/\bsudo\b|--insecure|\s-k\b/u);
    expect(script).toContain("--proto-redir");
    expect(script).toContain("--max-time");
  });
});

describe("Windows install script", () => {
  test("verifies the checksum before installation without elevation", async () => {
    const script = await readFile(POWERSHELL_SCRIPT, "utf-8");
    expect(script.indexOf("Get-FileHash")).toBeLessThan(
      script.indexOf("Move-Item"),
    );
    expect(script.indexOf("Checksum mismatch")).toBeLessThan(
      script.indexOf("[System.IO.File]::Replace"),
    );
    expect(script).not.toMatch(
      /RunAs|Start-Process|SkipCertificateCheck|sudo/iu,
    );
    expect(script).toContain("'User'");
    expect(script).toContain("STELLA_NO_MODIFY_PATH");
    expect(script).toContain("[TimeSpan]::FromSeconds(300)");
    expect(script).toContain("$handler.AllowAutoRedirect = $false");
    expect(script).toContain("$uri.Scheme -ne 'https'");
    expect(script).toContain(
      "(Join-Path $configDir 'install-path'), \"$destination`n\"",
    );
  });
  test.skipIf(!Bun.which("pwsh"))(
    "PowerShell parses the script when available",
    () => {
      const result = Bun.spawnSync({
        cmd: [
          "pwsh",
          "-NoProfile",
          "-Command",
          "$parseErrors = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:STELLA_SCRIPT_TO_PARSE, [ref]$null, [ref]$parseErrors) | Out-Null; if ($parseErrors.Count) { $parseErrors | Out-String | Write-Error; exit 1 }",
        ],
        env: { ...process.env, STELLA_SCRIPT_TO_PARSE: POWERSHELL_SCRIPT },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    },
  );
});
