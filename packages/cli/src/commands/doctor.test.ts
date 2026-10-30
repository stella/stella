import { Result } from "better-result";
import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  doctorLines,
  inspectPathInstallations,
  resolveDoctorNativePath,
} from "./doctor.js";

test.each(["npm-first", "native-first"])(
  "doctor reports every installation in PATH order and the migration command (%s)",
  async (order) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stella-doctor-"));
    try {
      const npmBin = path.join(dir, "npm", "bin");
      const nativeBin = path.join(dir, ".local", "bin");
      const npmTarget = path.join(
        dir,
        "npm",
        "lib",
        "node_modules",
        "@stll",
        "cli",
        "dist",
        "cli.js",
      );
      await Promise.all([
        mkdir(npmBin, { recursive: true }),
        mkdir(nativeBin, { recursive: true }),
        mkdir(path.dirname(npmTarget), { recursive: true }),
      ]);
      await writeFile(npmTarget, "#!/usr/bin/env node\n", { mode: 0o755 });
      await symlink(npmTarget, path.join(npmBin, "stella"));
      const nativePath = path.join(nativeBin, "stella");
      await writeFile(nativePath, "native", { mode: 0o755 });
      const directories =
        order === "npm-first" ? [npmBin, nativeBin] : [nativeBin, npmBin];
      const inspection = await inspectPathInstallations({
        pathValue: directories.join(":"),
        nativePath,
        platform: "linux",
      });
      expect(Result.isOk(inspection)).toBe(true);
      if (Result.isError(inspection)) {
        return;
      }
      const installations = inspection.value;
      expect(installations.map((entry) => entry.path)).toEqual(
        directories.map((directory) => path.join(directory, "stella")),
      );
      expect(installations.map((entry) => entry.channel)).toEqual(
        order === "npm-first" ? ["npm", "native"] : ["native", "npm"],
      );
      const report = doctorLines({
        installations,
        channel: "native",
        version: "6.2.0",
      }).join("\n");
      expect(report).toContain("Install channel: native");
      expect(report).toContain("Version: 6.2.0");
      expect(report).toContain("npm uninstall -g @stll/cli");
      expect(report).toContain(
        `${order === "npm-first" ? "npm" : "native"} stella shadows`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("doctor skips non-executable files and directories named stella", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-doctor-"));
  try {
    const fileBin = path.join(dir, "file");
    const directoryBin = path.join(dir, "directory");
    await mkdir(fileBin);
    await mkdir(path.join(directoryBin, "stella"), { recursive: true });
    await writeFile(path.join(fileBin, "stella"), "not executable", {
      mode: 0o644,
    });
    expect(
      await inspectPathInstallations({
        pathValue: [fileBin, directoryBin].join(":"),
        nativePath: "/unused",
        platform: "linux",
      }),
    ).toEqual(Result.ok([]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor finds a recorded custom native installation through a PATH alias after npm", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-doctor-custom-"));
  try {
    const configDir = path.join(dir, "config");
    const customBin = path.join(dir, "custom", "tools");
    const aliasBin = path.join(dir, "alias");
    const npmBin = path.join(dir, "npm", "bin");
    const npmTarget = path.join(dir, "node_modules", "@stll", "cli", "cli.js");
    await Promise.all(
      [configDir, customBin, aliasBin, npmBin, path.dirname(npmTarget)].map(
        (directory) => mkdir(directory, { recursive: true }),
      ),
    );
    const installedPath = path.join(customBin, "stella");
    await writeFile(installedPath, "native", { mode: 0o755 });
    await writeFile(npmTarget, "npm", { mode: 0o755 });
    await symlink(installedPath, path.join(aliasBin, "stella"));
    await symlink(npmTarget, path.join(npmBin, "stella"));
    await writeFile(path.join(configDir, "install-path"), `${installedPath}\n`);
    const nativePath = await resolveDoctorNativePath({
      configDir,
      defaultPath: "/unused/.local/bin/stella",
    });
    expect(nativePath).toEqual(Result.ok(installedPath));
    if (Result.isError(nativePath)) {
      return;
    }
    const inspection = await inspectPathInstallations({
      pathValue: [npmBin, aliasBin].join(":"),
      nativePath: nativePath.value,
      platform: "linux",
    });
    expect(Result.isOk(inspection)).toBe(true);
    if (Result.isError(inspection)) {
      return;
    }
    const installations = inspection.value;
    expect(installations.map((entry) => entry.channel)).toEqual([
      "npm",
      "native",
    ]);
    expect(
      doctorLines({ installations, channel: "npm", version: "6.2.0" }).join(
        "\n",
      ),
    ).toContain("npm stella shadows the native copy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor falls back only for an absent installation path record", async () => {
  const configDir = await mkdtemp(
    path.join(os.tmpdir(), "stella-doctor-path-"),
  );
  try {
    expect(
      await resolveDoctorNativePath({
        configDir,
        defaultPath: "/default/stella",
      }),
    ).toEqual(Result.ok("/default/stella"));
    expect(
      await resolveDoctorNativePath({
        configDir,
        defaultPath: "/default/stella",
        activeNativePath: "/active/stella",
      }),
    ).toEqual(Result.ok("/active/stella"));
    await mkdir(path.join(configDir, "install-path"));
    const failed = await resolveDoctorNativePath({
      configDir,
      defaultPath: "/default/stella",
    });
    expect(Result.isError(failed)).toBe(true);
    if (Result.isError(failed)) {
      expect(failed.error._tag).toBe("DoctorError");
      expect(failed.error.cause).toMatchObject({ code: "EISDIR" });
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("doctor returns tagged failures for invalid records and cyclic PATH entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-doctor-errors-"));
  try {
    await writeFile(path.join(root, "install-path"), "relative/stella");
    const invalid = await resolveDoctorNativePath({
      configDir: root,
      defaultPath: "/default/stella",
    });
    expect(Result.isError(invalid)).toBe(true);
    if (Result.isError(invalid)) {
      expect(invalid.error.message).toContain("must be absolute");
    }
    await symlink("stella", path.join(root, "stella"));
    const cycle = await inspectPathInstallations({
      pathValue: root,
      nativePath: path.join(root, "absent"),
      platform: "linux",
    });
    expect(Result.isError(cycle)).toBe(true);
    if (Result.isError(cycle)) {
      expect(cycle.error._tag).toBe("DoctorError");
      expect(cycle.error.cause).toMatchObject({ code: "ELOOP" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor fix preserves existing backup links and remains reversible on success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-doctor-fix-"));
  try {
    const configHome = path.join(root, "config");
    const configDir = path.join(configHome, "stella");
    const npmBin = path.join(root, "npm-bin");
    const nativeBin = path.join(root, "native-bin");
    const npmTarget = path.join(root, "node_modules", "@stll", "cli", "cli.js");
    await Promise.all(
      [configDir, npmBin, nativeBin, path.dirname(npmTarget)].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    const nativePath = path.join(nativeBin, "stella");
    const shadowPath = path.join(npmBin, "stella");
    const backup = `${shadowPath}.stella-disabled`;
    await writeFile(nativePath, "native", { mode: 0o755 });
    await writeFile(npmTarget, "npm fixture", { mode: 0o755 });
    await symlink(npmTarget, shadowPath);
    await writeFile(path.join(configDir, "install-path"), nativePath);
    const run = async (args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dirname, "../cli.ts"),
          "doctor",
          ...args,
        ],
        {
          env: {
            ...process.env,
            XDG_CONFIG_HOME: configHome,
            PATH: [npmBin, nativeBin].join(path.delimiter),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    const readOnly = await run([]);
    expect(readOnly.exitCode).toBe(0);
    expect(await readlink(shadowPath)).toBe(npmTarget);
    await symlink(path.basename(backup), backup);
    const refused = await run(["--fix"]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toMatch(/backup/iu);
    expect(await readlink(shadowPath)).toBe(npmTarget);
    await rm(backup);
    await symlink("absent-backup-target", backup);
    const danglingBackup = await run(["--fix"]);
    expect(danglingBackup.exitCode).toBe(2);
    expect(await readlink(backup)).toBe("absent-backup-target");
    expect(await readlink(shadowPath)).toBe(npmTarget);
    await rm(backup);
    const fixed = await run(["--fix"]);
    expect(fixed.exitCode).toBe(0);
    expect(fixed.stdout).toContain("Undo: mv");
    expect((await lstat(backup)).isSymbolicLink()).toBe(true);
    expect(await readFile(nativePath, "utf-8")).toBe("native");
    await rename(backup, shadowPath);
    expect(await readlink(shadowPath)).toBe(npmTarget);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
