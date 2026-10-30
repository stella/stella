import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
      const installations = await inspectPathInstallations({
        pathValue: directories.join(":"),
        nativePath,
        platform: "linux",
      });
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
    ).toEqual([]);
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
    expect(nativePath).toBe(installedPath);
    const installations = await inspectPathInstallations({
      pathValue: [npmBin, aliasBin].join(":"),
      nativePath,
      platform: "linux",
    });
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
    ).toBe("/default/stella");
    expect(
      await resolveDoctorNativePath({
        configDir,
        defaultPath: "/default/stella",
        activeNativePath: "/active/stella",
      }),
    ).toBe("/active/stella");
    await mkdir(path.join(configDir, "install-path"));
    const failed = await Result.tryPromise({
      try: () =>
        resolveDoctorNativePath({ configDir, defaultPath: "/default/stella" }),
      catch: (cause) => cause,
    });
    expect(Result.isError(failed)).toBe(true);
    if (Result.isError(failed)) {
      expect(String(failed.error)).toContain("EISDIR");
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
