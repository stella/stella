import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ENV_CATALOG, ENV_OWNER } from "./env-catalog";
import {
  renderSelfhostCompose,
  SELFHOST_APPLICATION_IMAGE_EXPRESSION,
  selfhostComposeViolations,
} from "./selfhost-contract";
import {
  isImmutableApplicationImage,
  materializeSelfhostTemplateForValidation,
  renderSelfhostEnvExample,
  workflowHealthContractIssues,
} from "./selfhost-tool";

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
    expect(example).toContain('SELFHOST_LOCAL_PASSWORD_AUTH="true"');
    expect(example).toContain('SELFHOST_BOOTSTRAP_TOKEN=""');
    expect(example).toContain('USE_MOCK_AI="false"');
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

describe("self-host workflow contract", () => {
  test("rejects readiness aliases used as local API bootstrap probes", () => {
    const workflowPath = ".github/actions/setup-e2e-stack/action.yml";
    expect(
      workflowHealthContractIssues([
        {
          content: "curl -sf http://localhost:3001/health",
          path: workflowPath,
        },
      ]),
    ).toEqual([
      `${workflowPath} must use /live when waiting for a local API process to boot.`,
    ]);
    expect(
      workflowHealthContractIssues([
        {
          content: "curl -sf http://localhost:3001/live",
          path: workflowPath,
        },
      ]),
    ).toEqual([]);
  });
});
