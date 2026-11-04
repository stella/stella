import { describe, expect, test } from "bun:test";

import { type RunCargo, updateCrates } from "./cargo-update";
import {
  CRATES_IO_SOURCE,
  createCratesIoClient,
  readCargoLockPins,
} from "./crates-io-release-age";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysBefore = (days: number) =>
  new Date(NOW.getTime() - days * DAY_MS).toISOString();
const QUARANTINE_SECONDS = 432_000;
const MANIFEST = "packages/example/Cargo.toml";

type Versions = Readonly<Record<string, string>>;

/** crates.io answering per-version and paginated version-list reads. */
const fakeCratesIo = (
  published: Readonly<Record<string, Versions>>,
  yanked: ReadonlySet<string> = new Set(),
) => {
  const requested: string[] = [];
  const client = createCratesIoClient({
    fetch: async (url) => {
      requested.push(url);
      const { pathname, searchParams } = new URL(url);
      const [name = "", rest = ""] = pathname
        .slice("/api/v1/crates/".length)
        .split(/\/(.*)/u);
      const times = published[name];
      if (times === undefined) {
        return new Response("not found", { status: 404 });
      }
      const entry = (num: string) => ({
        created_at: times[num],
        num,
        yanked: yanked.has(`${name}@${num}`),
      });
      if (rest === "versions") {
        // Two versions per page, newest first, to exercise pagination.
        const all = Object.keys(times).toSorted((a, b) =>
          Bun.semver.order(b, a),
        );
        const start = Number(searchParams.get("seek") ?? "0");
        const next =
          start + 2 < all.length ? `?seek=${String(start + 2)}` : null;
        return Response.json({
          meta: { next_page: next, total: all.length },
          versions: all.slice(start, start + 2).map(entry),
        });
      }
      return times[rest] === undefined
        ? new Response("not found", { status: 404 })
        : Response.json({ version: entry(rest) });
    },
    intervalMs: 0,
    retryDelayMs: 0,
  });
  return { client, requested };
};

const render = (lock: ReadonlyMap<string, string>) =>
  [
    "version = 4",
    ...[...lock].flatMap(([name, version]) => [
      "",
      "[[package]]",
      `name = "${name}"`,
      `version = "${version}"`,
      `source = "${CRATES_IO_SOURCE}"`,
    ]),
    "",
  ].join("\n");

/**
 * A Cargo stand-in over an in-memory lock: `update -p <crate>` applies the
 * resolution the fixture names, `--precise` accepts only versions the
 * fixture says satisfy the requirements.
 */
const fakeCargo = ({
  initial,
  resolutions,
  satisfies,
}: {
  initial: Readonly<Record<string, string>>;
  resolutions: Readonly<Record<string, Readonly<Record<string, string>>>>;
  satisfies: (name: string, version: string) => boolean;
}) => {
  let text = render(new Map(Object.entries(initial)));
  const calls: string[][] = [];
  const lockMap = () =>
    new Map(
      readCargoLockPins(text, "Cargo.lock").pins.map(({ name, version }) => [
        name,
        version,
      ]),
    );
  const cargo: RunCargo = (args) => {
    calls.push([...args]);
    const lock = lockMap();
    const preciseIndex = args.indexOf("--precise");
    const specs = args.flatMap((arg, index) =>
      args[index - 1] === "-p" ? [arg] : [],
    );
    if (preciseIndex !== -1) {
      const [spec = ""] = specs;
      const [name = "", version] = spec.split("@");
      const target = args[preciseIndex + 1] ?? "";
      if (lock.get(name) !== version) {
        return {
          ok: false,
          output: `error: package ID specification \`${spec}\` did not match any packages`,
        };
      }
      if (!satisfies(name, target)) {
        return {
          ok: false,
          output: `error: failed to select a version for the requirement \`${name} = "${target}"\``,
        };
      }
      lock.set(name, target);
    } else {
      for (const spec of specs) {
        for (const [name, version] of Object.entries(resolutions[spec] ?? {})) {
          lock.set(name, version);
        }
      }
    }
    text = render(lock);
    return { ok: true, output: "" };
  };
  return {
    calls,
    cargo,
    lockfile: {
      read: () => text,
      write: (next: string) => {
        text = next;
      },
    },
    lockMap,
    original: text,
  };
};

const run = async (
  cargo: ReturnType<typeof fakeCargo>,
  cratesIo: ReturnType<typeof fakeCratesIo>,
  crates: readonly string[],
  excluded: ReadonlySet<string> = new Set(),
) =>
  updateCrates({
    cargo: cargo.cargo,
    client: cratesIo.client,
    crates,
    isExcluded: (name) => excluded.has(name),
    lockfile: cargo.lockfile,
    manifestPath: MANIFEST,
    minimumReleaseAgeSeconds: QUARANTINE_SECONDS,
    now: NOW,
  });

describe("cargo:update", () => {
  test("pins young direct and transitive pins back to the newest aged version, and only resolves", async () => {
    const cratesIo = fakeCratesIo({
      image: {
        "0.25.10": daysBefore(90),
        "0.25.11": daysBefore(20),
        "0.25.12": daysBefore(1),
      },
      "fresh-dep": {
        "1.0.0": daysBefore(60),
        "1.1.0": daysBefore(10),
        "1.2.0-rc.1": daysBefore(8),
        "1.2.0": daysBefore(2),
      },
      "old-dep": { "2.0.0": daysBefore(400) },
    });
    const cargo = fakeCargo({
      initial: { image: "0.25.10", "old-dep": "2.0.0" },
      resolutions: { image: { image: "0.25.12", "fresh-dep": "1.2.0" } },
      satisfies: () => true,
    });

    const outcome = await run(cargo, cratesIo, ["image"]);

    expect(outcome.kind).toBe("updated");
    expect(Object.fromEntries(cargo.lockMap())).toEqual({
      "fresh-dep": "1.1.0",
      image: "0.25.11",
      "old-dep": "2.0.0",
    });
    expect(cargo.calls).toEqual([
      ["update", "--manifest-path", MANIFEST, "-p", "image"],
      [
        "update",
        "--manifest-path",
        MANIFEST,
        "-p",
        "image@0.25.12",
        "--precise",
        "0.25.11",
      ],
      [
        "update",
        "--manifest-path",
        MANIFEST,
        "-p",
        "fresh-dep@1.2.0",
        "--precise",
        "1.1.0",
      ],
    ]);
    // The unchanged pin is never looked up.
    expect(cratesIo.requested.some((url) => url.includes("/old-dep"))).toBe(
      false,
    );
  });

  test("skips versions Cargo refuses and yanked ones", async () => {
    const cratesIo = fakeCratesIo(
      {
        image: {
          "0.25.8": daysBefore(200),
          "0.25.9": daysBefore(100),
          "0.25.10": daysBefore(90),
          "0.25.11": daysBefore(1),
        },
      },
      new Set(["image@0.25.10"]),
    );
    const cargo = fakeCargo({
      initial: { image: "0.24.0" },
      resolutions: { image: { image: "0.25.11" } },
      satisfies: (_name, version) => version !== "0.25.9",
    });

    const outcome = await run(cargo, cratesIo, ["image"]);

    expect(outcome.kind).toBe("updated");
    expect(cargo.lockMap().get("image")).toBe("0.25.8");
  });

  test("restores the original lock when no aged version satisfies", async () => {
    const cratesIo = fakeCratesIo({
      image: { "0.25.10": daysBefore(90), "0.25.11": daysBefore(1) },
    });
    const cargo = fakeCargo({
      initial: { image: "0.25.10" },
      resolutions: { image: { image: "0.25.11" } },
      satisfies: (_name, version) => version === "0.25.11",
    });

    const outcome = await run(cargo, cratesIo, ["image"]);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") {
      return;
    }
    expect(outcome.message).toContain(
      "image@0.25.11 is younger than the quarantine, and no older published version that has cleared it satisfies the dependency requirements",
    );
    expect(outcome.message).toContain('"cargo:image" exclude to bunfig.toml');
    expect(outcome.message).toContain("Restored the original Cargo.lock.");
    expect(cargo.lockfile.read()).toBe(cargo.original);
  });

  test("restores the original lock when crates.io cannot answer", async () => {
    const cratesIo = fakeCratesIo({});
    const cargo = fakeCargo({
      initial: { image: "0.25.10" },
      resolutions: { image: { image: "0.25.11" } },
      satisfies: () => true,
    });

    const outcome = await run(cargo, cratesIo, ["image"]);

    expect(outcome).toMatchObject({
      kind: "failed",
      message: expect.stringContaining(
        "Could not read the publish time of image@0.25.11: crates.io answered HTTP 404",
      ),
    });
    expect(cargo.lockfile.read()).toBe(cargo.original);
  });

  test("keeps a young crate an active cargo: exclude admits", async () => {
    const cratesIo = fakeCratesIo({
      image: { "0.25.10": daysBefore(90), "0.25.11": daysBefore(1) },
    });
    const cargo = fakeCargo({
      initial: { image: "0.25.10" },
      resolutions: { image: { image: "0.25.11" } },
      satisfies: () => true,
    });

    const outcome = await run(
      cargo,
      cratesIo,
      ["image"],
      new Set(["cargo:image"]),
    );

    expect(outcome.kind).toBe("updated");
    expect(cargo.lockMap().get("image")).toBe("0.25.11");
    expect(cratesIo.requested).toEqual([]);
  });
});
