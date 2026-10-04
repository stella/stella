import { expect, test } from "bun:test";

import { readTauriPairs } from "./check-tauri-package-alignment";
import {
  latestEligibleTauriPatch,
  planTauriRepairs,
  repairTauriCargoManifest,
  repairTauriNpmManifest,
  readTauriRegistryVersions,
  TauriAutofixError,
} from "./fix-tauri-package-alignment";

type PairFixtureOptions = {
  api: string;
  cli: string;
  crate: string;
  plugin?: { name: string; npm: string; crate: string };
};
const fixture = ({ api, cli, crate, plugin }: PairFixtureOptions) => {
  const packages: Record<string, string[]> = {
    "@tauri-apps/api": [`@tauri-apps/api@${api}`],
    "@tauri-apps/cli": [`@tauri-apps/cli@${cli}`],
    "@tauri-apps/cli-darwin-arm64": [`@tauri-apps/cli-darwin-arm64@${cli}`],
  };
  let cargo = `[[package]]\nname = "tauri"\nversion = "${crate}"\n`;
  if (plugin !== undefined) {
    packages[`@tauri-apps/plugin-${plugin.name}`] = [
      `@tauri-apps/plugin-${plugin.name}@${plugin.npm}`,
    ];
    cargo += `[[package]]\nname = "tauri-plugin-${plugin.name}"\nversion = "${plugin.crate}"\n`;
  }
  return readTauriPairs(JSON.stringify({ packages }), cargo);
};

test("either ecosystem drives its counterparts to one changed release line", () => {
  const base = fixture({ api: "2.11.1", cli: "2.11.5", crate: "2.11.0" });
  for (const target of ["2.12.0", "3.0.0"]) {
    for (const head of [
      fixture({ api: "2.11.1", cli: "2.11.5", crate: target }),
      fixture({ api: target, cli: "2.11.5", crate: "2.11.0" }),
      fixture({ api: "2.11.1", cli: target, crate: "2.11.0" }),
      fixture({ api: target, cli: "2.11.5", crate: target }),
    ]) {
      const { repairs, errors } = planTauriRepairs({ base, head });
      expect(errors).toEqual([]);
      expect(repairs).toEqual([
        {
          crate: "tauri",
          line: target.slice(0, target.lastIndexOf(".")),
          npm: [
            "@tauri-apps/api",
            "@tauri-apps/cli",
            "@tauri-apps/cli-darwin-arm64",
          ],
        },
      ]);
      const aligned = fixture({ api: target, cli: target, crate: target });
      expect(planTauriRepairs({ base, head: aligned })).toEqual({
        repairs: [],
        errors: [],
      });
    }
  }
});

test("patch differences are already aligned without registry requests", () => {
  const base = fixture({ api: "2.12.0", cli: "2.12.0", crate: "2.12.0" });
  const head = fixture({ api: "2.12.99", cli: "2.12.1", crate: "2.12.9" });
  expect(planTauriRepairs({ base, head })).toEqual({ repairs: [], errors: [] });
});

test("every plugin is derived from the shared pair table", () => {
  for (const name of ["opener", "new-plugin"]) {
    const base = fixture({
      api: "2.12.0",
      cli: "2.12.0",
      crate: "2.12.0",
      plugin: { name, npm: "2.5.0", crate: "2.5.0" },
    });
    const head = fixture({
      api: "2.12.0",
      cli: "2.12.0",
      crate: "2.12.0",
      plugin: { name, npm: "2.5.0", crate: "2.6.0" },
    });
    expect(planTauriRepairs({ base, head })).toEqual({
      repairs: [
        {
          crate: `tauri-plugin-${name}`,
          line: "2.6",
          npm: [`@tauri-apps/plugin-${name}`],
        },
      ],
      errors: [],
    });
  }
});

test("conflicting changes, inherited drift, downgrades and duplicates need a decision", () => {
  const base = fixture({ api: "2.11.0", cli: "2.11.0", crate: "2.11.0" });
  expect(
    planTauriRepairs({
      base,
      head: fixture({ api: "2.13.0", cli: "2.11.0", crate: "2.12.0" }),
    }),
  ).toEqual({
    repairs: [],
    errors: ["tauri: conflicting or unchanged release lines; align manually"],
  });
  const drift = fixture({ api: "2.11.0", cli: "2.11.0", crate: "2.12.0" });
  expect(planTauriRepairs({ base: drift, head: drift })).toEqual({
    repairs: [],
    errors: ["tauri: conflicting or unchanged release lines; align manually"],
  });
  const aligned = fixture({ api: "2.12.0", cli: "2.12.0", crate: "2.12.0" });
  expect(
    planTauriRepairs({
      base: aligned,
      head: fixture({ api: "2.11.0", cli: "2.12.0", crate: "2.12.0" }),
    }),
  ).toEqual({
    repairs: [],
    errors: ["tauri: refusing an automatic downgrade to 2.11"],
  });
  const duplicate = readTauriPairs(
    '{"packages":{"@tauri-apps/api":["@tauri-apps/api@2.12.0"]}}',
    '[[package]]\nname = "tauri"\nversion = "2.11.0"\n[[package]]\nname = "tauri"\nversion = "2.11.1"',
  );
  expect(planTauriRepairs({ base, head: duplicate })).toEqual({
    repairs: [],
    errors: ["tauri: multiple crate resolutions; align manually"],
  });
});

test("unknown packages prevent every repair", () => {
  const base = fixture({ api: "2.12.0", cli: "2.12.0", crate: "2.12.0" });
  const head = readTauriPairs(
    '{"packages":{"@tauri-apps/unknown":["@tauri-apps/unknown@2.12.0"]}}',
    '[[package]]\nname = "tauri"\nversion = "2.12.0"',
  );
  expect(planTauriRepairs({ base, head })).toEqual({
    repairs: [],
    errors: [
      "@tauri-apps/unknown@2.12.0: no Tauri pair rule (add one to TAURI_PAIR_RULES)",
    ],
  });
});

test("selects the latest stable patch while preserving the five-day quarantine", () => {
  const now = Date.parse("2026-10-04T18:00:00Z");
  const versions = [
    {
      version: "2.12.0",
      publishedAt: "2026-09-26T00:00:00Z",
      status: "available",
    },
    {
      version: "2.12.1",
      publishedAt: "2026-09-30T21:59:05Z",
      status: "available",
    },
    {
      version: "2.12.9",
      publishedAt: "2026-09-20T00:00:00Z",
      status: "available",
    },
    {
      version: "2.12.10",
      publishedAt: "2026-09-20T00:00:00Z",
      status: "available",
    },
    {
      version: "2.12.11",
      publishedAt: "2026-09-20T00:00:00Z",
      status: "yanked",
    },
    {
      version: "2.12.99-beta.1",
      publishedAt: "2026-09-20T00:00:00Z",
      status: "available",
    },
    {
      version: "2.13.0",
      publishedAt: "2026-09-20T00:00:00Z",
      status: "available",
    },
    { version: "2.12.999", publishedAt: "invalid", status: "available" },
  ] as const;
  expect(
    latestEligibleTauriPatch({
      versions,
      line: "2.12",
      now,
      minimumAge: 432_000,
    }),
  ).toBe("2.12.10");
  expect(
    latestEligibleTauriPatch({
      versions: versions.slice(0, 2),
      line: "2.12",
      now,
      minimumAge: 432_000,
    }),
  ).toBe("2.12.0");
  expect(
    latestEligibleTauriPatch({
      versions,
      line: "3.0",
      now,
      minimumAge: 432_000,
    }),
  ).toBeUndefined();
});

test("registry decoding excludes unpublished npm releases and yanked crates", () => {
  const publishedAt = "2026-09-20T00:00:00Z";
  const versions = readTauriRegistryVersions(
    {
      versions: { "2.12.0": {} },
      time: { "2.12.0": publishedAt, "2.12.99": publishedAt },
    },
    "npm",
  );
  expect(versions).toEqual([
    { version: "2.12.0", publishedAt, status: "available" },
  ]);
  expect(
    latestEligibleTauriPatch({
      versions,
      line: "2.12",
      now: Date.parse("2026-10-04T18:00:00Z"),
      minimumAge: 432_000,
    }),
  ).toBe("2.12.0");
  expect(
    readTauriRegistryVersions(
      {
        versions: [
          { num: "2.12.0", created_at: publishedAt, yanked: false },
          { num: "2.12.1", created_at: publishedAt, yanked: true },
        ],
      },
      "cargo",
    ),
  ).toEqual([
    { version: "2.12.0", publishedAt, status: "available" },
    { version: "2.12.1", publishedAt, status: "yanked" },
  ]);
  expect(() => readTauriRegistryVersions({ time: {} }, "npm")).toThrow(
    "Missing npm versions/publish times",
  );
  expect(() => readTauriRegistryVersions({ versions: [{}] }, "cargo")).toThrow(
    "Invalid crate version",
  );
});

test("npm edits preserve unrelated bytes and converge on the selected line", () => {
  const text =
    '{\n  "dependencies": {"@tauri-apps/api": "^2.11.1", "other": "^1.0.0"},\n  "devDependencies": {"@tauri-apps/cli": "^2.11.5"},\n  "metadata": {"@tauri-apps/api": "leave"}\n}\n';
  const repairs = [
    { npm: "@tauri-apps/api", version: "2.12.0" },
    { npm: "@tauri-apps/cli", version: "2.12.0" },
  ];
  const updated = repairTauriNpmManifest(text, repairs);
  expect(updated).toBe(
    text.replace("^2.11.1", "~2.12.0").replace("^2.11.5", "~2.12.0"),
  );
  expect(repairTauriNpmManifest(updated, repairs)).toBe(updated);
  expect(() =>
    repairTauriNpmManifest(
      '{"dependencies":{"@tauri-apps/api":"catalog:"}}',
      repairs,
    ),
  ).toThrow(TauriAutofixError);
});

test("Cargo edits preserve features and unrelated dependencies, and converge", () => {
  for (const declaration of [
    'tauri = "2"',
    'tauri = { version = "2", features = [\n  "tray-icon",\n] }',
  ]) {
    const text = `[dependencies]\n${declaration}\nother = "2"\n`;
    const repair = { crate: "tauri", version: "2.12.0" };
    const updated = repairTauriCargoManifest(text, repair);
    expect(updated).toBe(text.replace('"2"', '"~2.12.0"'));
    expect(repairTauriCargoManifest(updated, repair)).toBe(updated);
  }
  expect(() =>
    repairTauriCargoManifest('[dependencies]\nother = "2"', {
      crate: "tauri",
      version: "2.12.0",
    }),
  ).toThrow("missing direct Cargo dependency");
  expect(() =>
    repairTauriCargoManifest('[dependencies.tauri]\nversion = "2"', {
      crate: "tauri",
      version: "2.12.0",
    }),
  ).toThrow("unsupported Cargo dependency declaration");
});
