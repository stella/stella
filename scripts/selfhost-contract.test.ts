import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ENV_CATALOG, ENV_OWNER } from "./env-catalog";
import {
  renderSelfhostCompose,
  SELFHOST_APPLICATION_IMAGE_EXPRESSION,
  SELFHOST_COMPOSE_ENV,
  selfhostComposeViolations,
} from "./selfhost-contract";
import {
  ambientComposeOverrideIssues,
  existingSelfhostComposeViolations,
  isImmutableApplicationImage,
  materializeSelfhostTemplateForValidation,
  productionEnvironmentIssues,
  releaseManifestIssues,
  renderSelfhostEnvExample,
  workflowContractIssues,
} from "./selfhost-tool";

setDefaultTimeout(15_000);

const repositoryCompose = async () =>
  await Bun.file(
    new URL("../docker-compose.selfhost.yml", import.meta.url),
  ).text();

describe("self-host Compose contract", () => {
  test("the committed file is generated and semantically valid", async () => {
    const compose = await repositoryCompose();
    expect(compose).toBe(renderSelfhostCompose());
    expect(selfhostComposeViolations(compose)).toEqual([]);
  });

  test("rejects an extra standalone scheduler in both inventory directions", () => {
    const compose = renderSelfhostCompose().replace(
      "\n  gotenberg:\n    image:",
      "\n  scheduler:\n    image: stella:scheduler\n\n  gotenberg:\n    image:",
    );
    expect(selfhostComposeViolations(compose)).toContain(
      "Compose services must be exactly: api, document-processing-worker, gotenberg.",
    );
  });

  test("rejects mutable application and converter images", () => {
    const compose = renderSelfhostCompose()
      .replaceAll(
        SELFHOST_APPLICATION_IMAGE_EXPRESSION,
        "ghcr.io/stella/stella-api:latest",
      )
      .replace(/gotenberg\/gotenberg:[^\n]+/u, "gotenberg/gotenberg:latest");
    expect(selfhostComposeViolations(compose)).toEqual(
      expect.arrayContaining([
        "api must use the required application image.",
        "document-processing-worker must use the required application image.",
        "gotenberg must use the contract's digest-pinned image.",
      ]),
    );
  });

  test("rejects missing readiness coverage", () => {
    const compose = renderSelfhostCompose().replace(
      "http://127.0.0.1:3001/ready",
      "http://127.0.0.1:3001/live",
    );
    expect(selfhostComposeViolations(compose)).toContain(
      "api healthcheck must probe /ready.",
    );
  });
});

describe("self-host production environment", () => {
  test("is generated from the repository release and API schema", () => {
    const example = renderSelfhostEnvExample();
    expect(example).toContain('STELLA_API_IMAGE=""');
    expect(example).toContain('CONTENT_ENCRYPTION_KEY=""');
    expect(example).toContain(
      "postgres://stella_owner:password@postgres.example.internal:5432/stella?sslmode=require",
    );
    expect(example).toContain('SELFHOST_LOCAL_PASSWORD_AUTH="true"');
    expect(example).toContain('SELFHOST_BOOTSTRAP_TOKEN=""');
    expect(example).toContain('USE_MOCK_AI="false"');
    expect(example).toContain(
      'REDIS_URL="rediss://valkey.example.internal:6379"',
    );
    expect(example).not.toMatch(/^EMAIL_PROVIDER=/mu);
    expect(example).not.toMatch(/^SMTP_HOST=/mu);

    for (const entry of ENV_CATALOG.filter(
      ({ documented, owner }) =>
        documented && owner !== ENV_OWNER.web && owner !== ENV_OWNER.collab,
    )) {
      expect(
        example.match(new RegExp(`^#? ?${entry.name}=`, "gmu")),
      ).toHaveLength(1);
    }
  });

  test.each([
    `ghcr.io/stella/stella-api@sha256:${"b".repeat(64)}`,
    `registry.example.com/legal/stella@sha256:${"a".repeat(64)}`,
  ])("accepts immutable application image %s", (image) => {
    expect(isImmutableApplicationImage(image)).toBe(true);
  });

  test.each([
    "ghcr.io/stella/stella-api:latest",
    "ghcr.io/stella/stella-api:main",
    "ghcr.io/stella/stella-api:v1.2.3",
    "registry.example.com/legal/stella:v1.2.3",
  ])("rejects mutable or unverifiable application image %s", (image) => {
    expect(isImmutableApplicationImage(image)).toBe(false);
  });

  test("reports every deployment-specific environment issue", () => {
    const environment = materializeSelfhostTemplateForValidation(
      renderSelfhostEnvExample(),
    )
      .replace(
        /^STELLA_API_IMAGE=.*$/mu,
        'STELLA_API_IMAGE="ghcr.io/stella/stella-api:latest"',
      )
      .replace(
        /^GOTENBERG_URL=.*$/mu,
        'GOTENBERG_URL="http://converter.example.com"',
      );

    // The Gotenberg rule now lives in the API's own deployed-environment
    // invariant, so the doctor reports it before its deployment checks run.
    expect(productionEnvironmentIssues(environment)).toEqual([
      "GOTENBERG_URL must use HTTPS unless it targets a loopback address or a private deployment network.",
    ]);
  });

  test("skips semantic Compose checks when the generated file is absent", () => {
    expect(
      existingSelfhostComposeViolations(
        path.join(tmpdir(), `missing-selfhost-${Bun.randomUUIDv7()}.yml`),
      ),
    ).toEqual([]);
  });

  test.each(Object.values(SELFHOST_COMPOSE_ENV))(
    "rejects a conflicting ambient %s override",
    (name) => {
      const environment = materializeSelfhostTemplateForValidation(
        renderSelfhostEnvExample(),
      );
      expect(
        ambientComposeOverrideIssues(environment, { [name]: "override" }),
      ).toContain(
        `${name} in the shell conflicts with the checked self-host environment file.`,
      );
    },
  );

  test("allows an ambient Compose value that matches the checked file", () => {
    const image = `ghcr.io/stella/stella-api@sha256:${"f".repeat(64)}`;
    const environment = materializeSelfhostTemplateForValidation(
      renderSelfhostEnvExample(),
    );
    expect(
      ambientComposeOverrideIssues(environment, {
        STELLA_API_IMAGE: image,
      }),
    ).toEqual([]);
  });

  test("materializes through the real Docker Compose parser", () => {
    if (!Bun.which("docker")) {
      return;
    }
    const directory = mkdtempSync(path.join(tmpdir(), "stella-selfhost-"));
    const envPath = path.join(directory, "production.env");
    const environment = materializeSelfhostTemplateForValidation(
      renderSelfhostEnvExample(),
    ).replace(
      'STELLA_API_ENV_FILE="deploy/selfhost/.env"',
      () => `STELLA_API_ENV_FILE="${envPath}"`,
    );
    writeFileSync(envPath, environment, { mode: 0o600 });
    const isolatedEnvironment = process.env["PATH"]
      ? { PATH: process.env["PATH"] }
      : {};
    const doctor = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--no-env-file",
        new URL("selfhost-tool.ts", import.meta.url).pathname,
        "doctor",
        envPath,
      ],
      cwd: new URL("..", import.meta.url).pathname,
      env: isolatedEnvironment,
      stderr: "pipe",
      stdout: "pipe",
    });
    const configured = Bun.spawnSync({
      cmd: [
        "docker",
        "compose",
        "--env-file",
        envPath,
        "-f",
        new URL("../docker-compose.selfhost.yml", import.meta.url).pathname,
        "config",
        "--quiet",
      ],
      env: isolatedEnvironment,
      stderr: "pipe",
      stdout: "pipe",
    });
    rmSync(directory, { recursive: true });
    expect(doctor.stderr.toString()).toBe("");
    expect(doctor.exitCode).toBe(0);
    expect(configured.stderr.toString()).toBe("");
    expect(configured.exitCode).toBe(0);
  });
});

describe("release manifest contract", () => {
  const digestArtifact = {
    reference: `ghcr.io/stella/stella-api@sha256:${"a".repeat(64)}`,
  };

  test("accepts digest-qualified artifact references", () => {
    expect(
      releaseManifestIssues({
        image: digestArtifact,
        webImage: digestArtifact,
      }),
    ).toEqual([]);
  });

  test.each(["image", "webImage"])(
    "rejects a mutable %s reference",
    (manifestKey) => {
      expect(
        releaseManifestIssues({
          image: digestArtifact,
          webImage: digestArtifact,
          [manifestKey]: { reference: "ghcr.io/stella/stella:latest" },
        }),
      ).toContain(
        `Release manifest ${manifestKey}.reference must be a digest-qualified image reference.`,
      );
    },
  );
});

describe("self-host workflow contract", () => {
  test("rejects readiness aliases used as local API bootstrap probes", () => {
    const workflowPath = ".github/actions/setup-e2e-stack/action.yml";
    expect(
      workflowContractIssues([
        {
          content: "curl -sf http://localhost:3001/health",
          path: workflowPath,
        },
      ]),
    ).toEqual([
      `${workflowPath} must use /live when waiting for a local API process to boot.`,
    ]);
    expect(
      workflowContractIssues([
        {
          content: "curl -sf http://localhost:3001/live",
          path: workflowPath,
        },
      ]),
    ).toEqual([]);
  });

  test.each([
    "POSTGRES_USER: stella",
    "DATABASE_URL: postgres://stella:password@postgres:5432/stella",
    "run: pg_isready -h postgres -U stella -d stella",
    "run: psql -h postgres -U stella -d stella",
  ])("rejects the reserved RLS workflow login: %s", (content) => {
    const workflowPath = ".github/workflows/database.yml";
    expect(
      workflowContractIssues([
        {
          content,
          path: workflowPath,
        },
      ]),
    ).toEqual([
      `${workflowPath} must not use the reserved stella RLS role as a database login.`,
    ]);
  });

  test("accepts a distinct workflow database owner login", () => {
    const workflowPath = ".github/workflows/database.yml";
    expect(
      workflowContractIssues([
        {
          content: [
            "POSTGRES_USER: stella_owner",
            "DATABASE_URL: postgres://stella_owner:password@postgres:5432/stella",
            "run: psql -h postgres -U stella_owner -d stella",
          ].join("\n"),
          path: workflowPath,
        },
      ]),
    ).toEqual([]);
  });
});
