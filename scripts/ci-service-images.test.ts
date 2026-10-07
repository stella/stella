import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectImageReferences,
  compareMirrorImages,
} from "./ci-service-images";
import mirrorImages from "./ci-service-images.json" with { type: "json" };

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const fixture = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-service-images-"));
  fixtureRoots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  return root;
};

describe("CI service image discovery", () => {
  test("canonicalizes pinned and unpinned references and excludes existing mirrors", async () => {
    const root = fixture({
      ".github/workflows/ci.yml": `
name: CI
on: push
jobs:
  services:
    runs-on: ubuntu-latest
    services:
      database:
        image: postgres:17@sha256:${"a".repeat(64)}
      cache:
        image: docker.io/library/redis:7
      browser:
        image: mcr.microsoft.com/playwright:v1.55.0-noble
      mirrored:
        image: ghcr.io/example/postgres:17
      public-mirror:
        image: public.ecr.aws/example/redis:7
    steps:
      - run: docker run --rm -p 9000:9000 minio/minio:RELEASE.2025-04-22T22-12-26Z
      - run: docker pull postgres:17
`,
    });

    expect((await collectImageReferences(root)).toSorted()).toEqual([
      "docker.io/library/postgres:17",
      "docker.io/library/redis:7",
      "docker.io/minio/minio:RELEASE.2025-04-22T22-12-26Z",
      "mcr.microsoft.com/playwright:v1.55.0-noble",
    ]);
  });

  test("follows local actions and recursively referenced scripts, compose files and Dockerfiles", async () => {
    const root = fixture({
      ".github/workflows/ci.yml": `
name: CI
on: push
jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/integration
`,
      ".github/actions/integration/action.yml": `
name: integration
runs:
  using: composite
  steps:
    - shell: bash
      run: bash scripts/start-services.sh
`,
      "scripts/start-services.sh": `
bash scripts/nested-services.sh
docker compose -f fixtures/services.yml up -d
docker build -f fixtures/Dockerfile -t local-test-app .
docker run --rm local-test-app
docker build -f fixtures/Dockerfile -t local-test-app:integration .
docker run --rm local-test-app:integration
`,
      "scripts/nested-services.sh": `docker run --rm nginx:1.27@sha256:${"b".repeat(64)}\n`,
      "fixtures/services.yml": `
services:
  search:
    image: elasticsearch:8.17.0@sha256:${"c".repeat(64)}
  object-store:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
`,
      "fixtures/Dockerfile": `
FROM alpine:3.21@sha256:${"d".repeat(64)} AS base
RUN echo ready
FROM base AS build
FROM scratch
COPY --from=build /app /app
`,
      "unrelated/Dockerfile": "FROM ubuntu:24.04\n",
      "scripts/unrelated.sh": "docker run rabbitmq:4\n",
    });

    expect((await collectImageReferences(root)).toSorted()).toEqual([
      "docker.io/library/alpine:3.21",
      "docker.io/library/elasticsearch:8.17.0",
      "docker.io/library/nginx:1.27",
      "docker.io/minio/minio:RELEASE.2025-04-22T22-12-26Z",
    ]);
  });

  test("discovers default compose services and terminates cyclic script references", async () => {
    const root = fixture({
      ".github/workflows/ci.yml": `
name: CI
on: push
jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/start.sh
`,
      "scripts/start.sh": "bash scripts/restart.sh\ndocker compose up -d\n",
      "scripts/restart.sh": "bash scripts/start.sh\ndocker pull redis:7\n",
      "docker-compose.yml": "services:\n  db:\n    image: postgres:17\n",
    });

    expect((await collectImageReferences(root)).toSorted()).toEqual([
      "docker.io/library/postgres:17",
      "docker.io/library/redis:7",
    ]);
  });

  test("follows a referenced image variable file without treating unrelated text as inventory", async () => {
    const root = fixture({
      ".github/workflows/ci.yml": `
name: CI
on: push
jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/browser.sh
`,
      "scripts/browser.sh": `
browser_image=$(cat fixtures/browser-image.txt)
docker run --rm "$browser_image"
`,
      "fixtures/browser-image.txt": `mcr.microsoft.com/playwright:v1.55.0-noble@sha256:${"e".repeat(64)}\n`,
      "fixtures/unrelated-image.txt": `ubuntu:24.04@sha256:${"f".repeat(64)}\n`,
    });

    expect(await collectImageReferences(root)).toEqual([
      "mcr.microsoft.com/playwright:v1.55.0-noble",
    ]);
  });
});

describe("service image mirror inventory", () => {
  const references = [
    "docker.io/library/postgres:17",
    "docker.io/library/redis:7",
  ];
  const images = [
    { source: "docker.io/library/postgres:17", name: "postgres-17" },
    { source: "docker.io/library/redis:7", name: "redis-7" },
  ];

  test("accepts exactly the discovered image set regardless of ordering or repeated usage", () => {
    expect(
      compareMirrorImages([...references, ...references], images.toReversed()),
    ).toEqual([]);
  });

  test("reports every missing and stale source in the same comparison", () => {
    const errors = compareMirrorImages(references, [
      { source: "docker.io/library/postgres:17", name: "postgres-17" },
      { source: "docker.io/library/nginx:1.27", name: "nginx-1.27" },
    ]);

    expect(errors.join("\n")).toContain("docker.io/library/redis:7");
    expect(errors.join("\n")).toContain("docker.io/library/nginx:1.27");
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  test("rejects duplicate sources even when their mirror names differ", () => {
    const errors = compareMirrorImages(references, [
      ...images,
      { source: "docker.io/library/postgres:17", name: "postgres-alternate" },
    ]);

    expect(errors.join("\n")).toMatch(/duplicate/iu);
    expect(errors.join("\n")).toContain("docker.io/library/postgres:17");
  });

  test("rejects colliding mirror names even when the source set is complete", () => {
    const errors = compareMirrorImages(references, [
      { source: "docker.io/library/postgres:17", name: "database" },
      { source: "docker.io/library/redis:7", name: "database" },
    ]);

    expect(errors.join("\n")).toMatch(/duplicate/iu);
    expect(errors.join("\n")).toContain("database");
  });

  test.each([
    "postgres:17",
    "docker.io/postgres:17",
    "docker.io/library/postgres",
    `docker.io/library/postgres:17@sha256:${"a".repeat(64)}`,
    "https://docker.io/library/postgres:17",
    "ghcr.io/example/postgres:17",
    "docker.io/library/postgres:17 extra",
  ])("rejects noncanonical or untagged mirror source %s", (source) => {
    expect(
      compareMirrorImages([source], [{ source, name: "postgres-17" }]).join(
        "\n",
      ),
    ).toMatch(/invalid|canonical|tag|registry/iu);
  });

  test.each(["", "Database", "../postgres", "postgres:17", "postgres 17"])(
    "rejects invalid mirror name %s",
    (name) => {
      expect(
        compareMirrorImages(
          ["docker.io/library/postgres:17"],
          [{ source: "docker.io/library/postgres:17", name }],
        ).join("\n"),
      ).toMatch(/invalid|name/iu);
    },
  );
});

describe("CI image publishing boundary", () => {
  test("routes unattended mirror failures through the scheduled workflow alerts", () => {
    const mirrorPath = ".github/workflows/mirror-ci-service-images.yml";
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(path.join(import.meta.dir, "..", mirrorPath), "utf-8"),
    );
    if (
      typeof workflow !== "object" ||
      workflow === null ||
      !("name" in workflow)
    ) {
      throw new TypeError("Mirror workflow must declare a name");
    }
    expect(typeof workflow.name).toBe("string");
    const alerts: unknown = Bun.YAML.parse(
      readFileSync(
        path.join(
          import.meta.dir,
          "../.github/workflows/scheduled-run-alerts.yml",
        ),
        "utf-8",
      ),
    );

    expect(alerts).toHaveProperty(
      "on.workflow_run.workflows",
      expect.arrayContaining([workflow.name]),
    );
    expect(alerts).toHaveProperty(
      "jobs.notify.if",
      expect.stringContaining(`"${mirrorPath}"`),
    );
  });

  test("publishes only through manual or scheduled runs with narrowly scoped job permissions", () => {
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(
        path.join(
          import.meta.dir,
          "../.github/workflows/mirror-ci-service-images.yml",
        ),
        "utf-8",
      ),
    );

    expect(workflow).toEqual(
      expect.objectContaining({
        on: { workflow_dispatch: null, schedule: expect.any(Array) },
        permissions: {},
        jobs: expect.objectContaining({
          mirror: expect.objectContaining({
            permissions: { contents: "read", packages: "write" },
          }),
        }),
      }),
    );
  });
});

type MirrorScenario =
  | "success"
  | "copy-failure"
  | "digest-mismatch"
  | "inventory-failure"
  | "source-digest-failure"
  | "invalid-source-digest";

const runMirror = (scenario: MirrorScenario) => {
  const upstreamDigest = `sha256:${"a".repeat(64)}`;
  const cacheDigest = `sha256:${"b".repeat(64)}`;
  const root = fixture({
    "bin/bun": `#!/bin/bash
if [[ "$MIRROR_SCENARIO" == inventory-failure ]]; then exit 30; fi
printf 'docker.io/library/postgres:17\\tpostgres-17\\ndocker.io/library/redis:7\\tredis-7\\n'
`,
    "bin/crane": `#!/bin/bash
printf '%s\\t' "$@" >> "$MIRROR_COMMAND_LOG"
printf '\\n' >> "$MIRROR_COMMAND_LOG"
case "$1" in
  copy)
    if [[ "$MIRROR_SCENARIO" == copy-failure ]]; then exit 31; fi
    ;;
  digest)
    case "$2" in
      docker.io/library/postgres:17)
        if [[ "$MIRROR_SCENARIO" == source-digest-failure ]]; then exit 34; fi
        if [[ "$MIRROR_SCENARIO" == invalid-source-digest ]]; then
          printf 'not-a-digest\\n'
        else
          printf '%s\\n' '${upstreamDigest}'
        fi
        ;;
      docker.io/library/redis:7|ghcr.io/stella/ci-mirror/redis-7:7) printf '%s\\n' '${cacheDigest}' ;;
      ghcr.io/stella/ci-mirror/postgres-17:17)
        if [[ "$MIRROR_SCENARIO" == digest-mismatch ]]; then
          printf '%s\\n' '${cacheDigest}'
        else
          printf '%s\\n' '${upstreamDigest}'
        fi
        ;;
      *) exit 32 ;;
    esac
    ;;
  *) exit 33 ;;
esac
`,
    "commands.tsv": "",
    "summary.md": "",
  });
  chmodSync(path.join(root, "bin/bun"), 0o755);
  chmodSync(path.join(root, "bin/crane"), 0o755);
  const result = Bun.spawnSync({
    cmd: [
      "bash",
      path.join(import.meta.dir, "mirror-ci-service-images.sh"),
      path.join(root, "output"),
    ],
    env: {
      ...process.env,
      PATH: `${path.join(root, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      MIRROR_COMMAND_LOG: path.join(root, "commands.tsv"),
      MIRROR_SCENARIO: scenario,
      GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
    },
  });
  const commands = readFileSync(path.join(root, "commands.tsv"), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split("\t"));

  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    commands,
    digests: existsSync(path.join(root, "output/digests.tsv"))
      ? readFileSync(path.join(root, "output/digests.tsv"), "utf-8")
      : "",
    summary: readFileSync(path.join(root, "summary.md"), "utf-8"),
    upstreamDigest,
    cacheDigest,
  };
};

describe("registry copies and digest artifacts", () => {
  test("emits the validated inventory as actual tab-separated lines", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        path.join(import.meta.dir, "ci-service-images.ts"),
        "--list",
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      mirrorImages.map(({ source, name }) => `${source}\t${name}\n`).join(""),
    );
    expect(result.stdout.toString().trim().split("\n")).toHaveLength(
      mirrorImages.length,
    );
  });

  test("copies immutable platform indexes and records the verified target references", () => {
    const {
      exitCode,
      commands,
      digests,
      summary,
      upstreamDigest,
      cacheDigest,
    } = runMirror("success");

    expect(exitCode).toBe(0);
    const copies = commands.filter((command) => command.at(0) === "copy");
    expect(copies.map((command) => command.slice(-2))).toEqual([
      [
        `docker.io/library/postgres:17@${upstreamDigest}`,
        "ghcr.io/stella/ci-mirror/postgres-17:17",
      ],
      [
        `docker.io/library/redis:7@${cacheDigest}`,
        "ghcr.io/stella/ci-mirror/redis-7:7",
      ],
    ]);
    expect(
      copies.flat().some((argument) => argument.startsWith("--platform")),
    ).toBe(false);
    expect(digests).toBe(
      "source\treference\n" +
        `docker.io/library/postgres:17\tghcr.io/stella/ci-mirror/postgres-17@${upstreamDigest}\n` +
        `docker.io/library/redis:7\tghcr.io/stella/ci-mirror/redis-7@${cacheDigest}\n`,
    );
    expect(summary).toContain(
      `ghcr.io/stella/ci-mirror/postgres-17@${upstreamDigest}`,
    );
    expect(summary).toContain(
      `ghcr.io/stella/ci-mirror/redis-7@${cacheDigest}`,
    );
  });

  test("stops at a failed copy without publishing the next image or recording an unverified digest", () => {
    const { exitCode, commands, digests, summary } = runMirror("copy-failure");

    expect(exitCode).not.toBe(0);
    expect(commands.filter((command) => command.at(0) === "copy")).toHaveLength(
      1,
    );
    expect(commands.flat()).not.toContain("docker.io/library/redis:7");
    expect(digests).toBe("source\treference\n");
    expect(summary).toBe("");
  });

  test("rejects a changed target manifest before recording its digest or copying the next image", () => {
    const { exitCode, commands, digests, summary, stderr } =
      runMirror("digest-mismatch");

    expect(stderr).toContain("Target digest differs from source");
    expect(exitCode).not.toBe(0);
    expect(commands).toContainEqual([
      "digest",
      "ghcr.io/stella/ci-mirror/postgres-17:17",
    ]);
    expect(commands.flat()).not.toContain("docker.io/library/redis:7");
    expect(digests).toBe("source\treference\n");
    expect(summary).toBe("");
  });

  test.each([
    "inventory-failure",
    "source-digest-failure",
    "invalid-source-digest",
  ] as const)("stops before copying when %s occurs", (scenario) => {
    const { exitCode, commands, digests, summary, stderr } =
      runMirror(scenario);

    expect(exitCode).not.toBe(0);
    expect(commands.filter((command) => command.at(0) === "copy")).toEqual([]);
    expect(commands.flat()).not.toContain("docker.io/library/redis:7");
    expect(digests).toBe(
      scenario === "inventory-failure" ? "" : "source\treference\n",
    );
    expect(summary).toBe("");
    expect(commands).toEqual(
      scenario === "inventory-failure"
        ? []
        : [["digest", "docker.io/library/postgres:17"]],
    );
    if (scenario === "invalid-source-digest") {
      expect(stderr).toContain("Invalid source digest");
    }
  });
});
