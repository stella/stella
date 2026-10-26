import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  QUICKWIT_V09_BUILD_VERSION,
  QUICKWIT_V09_RUNTIME,
} from "@/api/lib/legal-search/corpus-index-engine-version";

import { readRepositoryFiles } from "../packages/scripts/src/tracked-files";
import { serviceVolumeMountViolations } from "./check-railway-template-draft";
import images from "./ci-service-images.json" with { type: "json" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordField = (
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> => {
  const candidate = value[field];
  if (!isRecord(candidate)) {
    throw new TypeError(`${field} must be an object`);
  }
  return candidate;
};

const stringField = (value: Record<string, unknown>, field: string): string => {
  const candidate = value[field];
  if (typeof candidate !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  return candidate;
};

const stringArrayField = (
  value: Record<string, unknown>,
  field: string,
): readonly string[] => {
  const candidate = value[field];
  if (
    !Array.isArray(candidate) ||
    !candidate.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError(`${field} must be an array of strings`);
  }
  return candidate;
};

const readComposeServices = async (): Promise<Record<string, unknown>> => {
  const compose: unknown = Bun.YAML.parse(
    await Bun.file(new URL("../docker-compose.yml", import.meta.url)).text(),
  );
  if (!isRecord(compose)) {
    throw new TypeError("Compose must be an object");
  }
  return recordField(compose, "services");
};

const LOOPBACK_HOST = "127.0.0.1";

// The repository inventory includes new deployment directories without walking
// dependency/build trees. Include untracked files for local authoring as well.
const deploymentTemplates = async () => {
  const templates = [];
  const inventory = readRepositoryFiles({
    root: new URL("..", import.meta.url),
    scope: "worktree",
  });
  if (Result.isError(inventory)) {
    throw new TypeError(
      "Deployment template inventory requires a Git checkout",
    );
  }
  const candidates = new Set(
    inventory.value.filter(
      (candidate) =>
        /\.(?:json|ya?ml)$/u.test(candidate) &&
        !candidate.startsWith(".github/") &&
        (!/^(?:apps|packages)\//u.test(candidate) ||
          /compose|deploy|selfhost|template|railway|render/iu.test(
            candidate,
          )) &&
        !/(?:^|\/)(?:node_modules|fixtures|__fixtures__|dist|build)\//u.test(
          candidate,
        ),
    ),
  );
  for (const candidate of candidates) {
    const contents = await Bun.file(
      new URL(`../${candidate}`, import.meta.url),
    ).text();
    if (!/(?:"services"|^services)\s*:/mu.test(contents)) {
      continue;
    }
    const parsed: unknown = candidate.endsWith(".json")
      ? JSON.parse(contents)
      : Bun.YAML.parse(contents);
    if (!isRecord(parsed) || parsed["services"] === undefined) {
      continue;
    }
    templates.push({
      path: candidate,
      services: recordField(parsed, "services"),
      contents,
    });
  }
  return templates;
};

describe("deployment database login contract", () => {
  test("requires the declared Postgres volume in the exported Railway service", () => {
    const expectedMount = "/var/lib/postgresql";
    for (const volumeMounts of [
      undefined,
      {},
      { data: { mountPath: "/var/lib/postgresql/data" } },
      { data: { mountPath: null } },
      [{ mountPath: expectedMount }],
    ]) {
      expect(
        serviceVolumeMountViolations({
          draftService: { volumeMounts },
          serviceName: "Postgres",
          volumeMountPath: expectedMount,
        }),
      ).toEqual([
        `Postgres must mount a persistent volume at ${expectedMount} in the template draft`,
      ]);
    }
    expect(
      serviceVolumeMountViolations({
        draftService: {
          volumeMounts: { "volume-id": { mountPath: expectedMount } },
        },
        serviceName: "Postgres",
        volumeMountPath: expectedMount,
      }),
    ).toEqual([]);
  });

  test("every database template creates and uses the initialized owner login", async () => {
    const templates = await deploymentTemplates();
    expect(templates.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "docker-compose.yml",
        "docker-compose.selfhost.yml",
        "railway/template-manifest.json",
      ]),
    );
    const initialization = await Bun.file(
      new URL("../docker/postgres/init.sql", import.meta.url),
    ).text();
    expect(initialization).toContain(
      "ALTER ROLE %I NOSUPERUSER NOBYPASSRLS CREATEROLE CREATEDB",
    );
    expect(initialization).toContain(
      "GRANT stella TO %I WITH ADMIN TRUE, INHERIT FALSE, SET TRUE",
    );
    const image = await Bun.file(
      new URL("../docker/postgres/Dockerfile", import.meta.url),
    ).text();
    expect(image).toContain(
      "COPY docker/postgres/init.sql /docker-entrypoint-initdb.d/init.sql",
    );

    for (const { path, services, contents } of templates) {
      const databaseServices = Object.entries(services).filter(
        ([name, service]) => {
          if (!isRecord(service)) {
            throw new TypeError(`${path}: ${name} must be an object`);
          }
          const variables = service["variables"] ?? service["environment"];
          // Client-only setup services inherit their server's login contract.
          const entrypoint = service["entrypoint"];
          const isDatabaseClient =
            Array.isArray(entrypoint) &&
            entrypoint.some(
              (part) =>
                typeof part === "string" &&
                part.includes("psql -h postgres -U postgres"),
            ) &&
            isRecord(service["depends_on"]) &&
            service["depends_on"]["postgres"] !== undefined;
          return (
            name.toLowerCase() === "postgres" ||
            (isRecord(variables) && variables["POSTGRES_USER"] !== undefined) ||
            (!isDatabaseClient &&
              typeof service["image"] === "string" &&
              service["image"].startsWith("postgres:"))
          );
        },
      );
      for (const [name, service] of databaseServices) {
        if (!isRecord(service)) {
          throw new TypeError(`${path}: ${name} must be an object`);
        }
        const build = recordField(service, "build");
        expect(build["dockerfilePath"] ?? build["dockerfile"]).toBe(
          "docker/postgres/Dockerfile",
        );
        const variables = recordField(
          service,
          service["variables"] === undefined ? "environment" : "variables",
        );
        expect(variables["POSTGRES_USER"]).toBe("postgres");
      }
      if (databaseServices.length === 0) {
        const api = recordField(services, "api");
        expect(recordField(api, "environment")["NODE_ENV"]).toBe("production");
        expect(contents).toContain("/ready");
        expect(contents).toContain("STELLA_API_ENV_FILE");
        continue;
      }
      if (path.endsWith(".json")) {
        const apiVariables = recordField(
          recordField(services, "api"),
          "variables",
        );
        expect(apiVariables["DATABASE_URL"]).toBe(
          `\${{Postgres.DATABASE_URL}}`,
        );
        const postgresVariables = recordField(
          recordField(services, "Postgres"),
          "variables",
        );
        expect(recordField(services, "Postgres")["volumeMountPath"]).toBe(
          "/var/lib/postgresql",
        );
        expect(postgresVariables["PGUSER"]).toBe(`\${{POSTGRES_USER}}`);
        expect(postgresVariables["DATABASE_URL"]).toStartWith(
          `postgresql://\${{PGUSER}}:`,
        );
      }
    }
  });
});

// Compose accepts both the short "host:published:target" string and the long
// `{ host_ip, published, target }` form.
const isLoopbackPublish = (port: unknown): boolean =>
  typeof port === "string"
    ? port.startsWith(`${LOOPBACK_HOST}:`)
    : isRecord(port) && port["host_ip"] === LOOPBACK_HOST;

describe("local compose services", () => {
  test("ships Postgres initialization from a seed-only image context", async () => {
    const services = await readComposeServices();
    const postgres = recordField(services, "postgres");
    expect(recordField(postgres, "build")).toEqual({
      context: ".",
      dockerfile: "docker/postgres/Dockerfile",
    });
    expect(stringArrayField(postgres, "volumes")).toEqual([
      "pgdata:/var/lib/postgresql",
    ]);
    const dockerfile = await Bun.file(
      new URL("../docker/postgres/Dockerfile", import.meta.url),
    ).text();
    expect(dockerfile).toContain(
      `FROM ${stringField(recordField(services, "quickwit09-postgres-setup"), "image")}`,
    );
    expect(dockerfile).toMatch(
      /^COPY docker\/postgres\/init\.sql \/docker-entrypoint-initdb\.d\/init\.sql$/mu,
    );
    expect(
      await Bun.file(
        new URL("../docker/postgres/Dockerfile.dockerignore", import.meta.url),
      ).text(),
    ).toBe(
      "*\n!docker/\ndocker/*\n!docker/postgres/\ndocker/postgres/*\n!docker/postgres/Dockerfile\n!docker/postgres/init.sql\n!docker/postgres/prod-parity.conf\n!docker/postgres/server.conf\n",
    );
  });

  test("publish host ports on loopback only", async () => {
    const services = await readComposeServices();
    const exposed = Object.entries(services).flatMap(([name, service]) => {
      if (!isRecord(service)) {
        throw new TypeError(`${name} must be an object`);
      }
      const ports = service["ports"];
      if (ports === undefined) {
        return [];
      }
      if (!Array.isArray(ports)) {
        throw new TypeError(`${name}.ports must be an array`);
      }
      return ports
        .filter((port) => !isLoopbackPublish(port))
        .map((port) => `${name}: ${JSON.stringify(port)}`);
    });

    expect(exposed).toEqual([]);
  });
});

describe("local Quickwit generation", () => {
  test("pins a runtime that reads the manifest's generations, on its own metastore", async () => {
    const services = await readComposeServices();
    const rustfsSetup = recordField(services, "rustfs-setup");
    const q09 = recordField(services, "quickwit09");
    const q09Setup = recordField(services, "quickwit09-postgres-setup");
    const q09Environment = recordField(q09, "environment");
    const rustfsSetupEnvironment = recordField(rustfsSetup, "environment");

    // One engine service, and it is the one the manifest declares.
    expect(
      Object.keys(services).filter((name) => name.startsWith("quickwit")),
    ).toEqual(["quickwit09-postgres-setup", "quickwit09"]);
    expect(stringField(q09, "image")).toStartWith(
      `quickwit/quickwit:${QUICKWIT_V09_RUNTIME.version}@sha256:`,
    );
    // A patch release of the line that built the generations reads their splits.
    const line = (version: string) => version.split(".").slice(0, 2).join(".");
    expect(line(QUICKWIT_V09_RUNTIME.version)).toBe(
      line(QUICKWIT_V09_BUILD_VERSION),
    );
    expect(stringField(q09Environment, "QW_METASTORE_URI")).toBe(
      "postgres://postgres:postgres@postgres:5432/stella_quickwit_09",
    );
    expect(stringField(q09Environment, "QW_DEFAULT_INDEX_ROOT_URI")).toBe(
      stringField(rustfsSetupEnvironment, "QUICKWIT09_INDEX_ROOT_URI"),
    );
    expect(stringField(rustfsSetup, "entrypoint")).toMatch(
      /quickwit09_bucket=\$\$\{QUICKWIT09_INDEX_ROOT_URI#s3:\/\/\}/u,
    );
    // The published host ports are what the test environment defaults to.
    expect(stringArrayField(q09, "ports")).toEqual([
      expect.stringContaining(":-7290}:7280"),
      expect.stringContaining(":-7291}:7281"),
    ]);
    expect(stringArrayField(q09, "profiles")).toEqual(["quickwit09"]);
    expect(stringArrayField(q09Setup, "profiles")).toEqual(["quickwit09"]);
  });

  test("CI runs the same engine image the manifest declares", async () => {
    const services = await readComposeServices();
    const composeImage = stringField(
      recordField(services, "quickwit09"),
      "image",
    );
    const workflow: unknown = Bun.YAML.parse(
      await Bun.file(
        new URL("../.github/workflows/ci.yml", import.meta.url),
      ).text(),
    );
    if (!isRecord(workflow)) {
      throw new TypeError("CI workflow must be an object");
    }
    const jobs = recordField(workflow, "jobs");
    const planner = recordField(jobs, "ci-plan");
    expect(stringField(recordField(planner, "outputs"), "quickwit")).toBe(
      `\${{ steps.images.outputs.quickwit }}`,
    );
    const plannerSteps = planner["steps"];
    if (!Array.isArray(plannerSteps)) {
      throw new TypeError("CI planner steps must be an array");
    }
    const resolver = plannerSteps.find(
      (step) => isRecord(step) && step["id"] === "images",
    );
    if (!isRecord(resolver)) {
      throw new TypeError("CI planner must resolve image sources");
    }
    expect(stringField(resolver, "run")).toContain(
      'bun scripts/ci-service-images.ts --resolve >> "$GITHUB_OUTPUT"',
    );
    const suites = recordField(jobs, "service-suites");
    const steps = suites["steps"];
    if (!Array.isArray(steps)) {
      throw new TypeError("CI service suite steps must be an array");
    }
    const engine = steps.find(
      (step) => isRecord(step) && step["name"] === "Start corpus engine",
    );
    if (!isRecord(engine)) {
      throw new TypeError("CI service suites must start the corpus engine");
    }
    expect(stringField(engine, "run")).toContain(
      `\${{ needs.ci-plan.outputs.quickwit }} run`,
    );
    const image = images.find(({ name }) => name === "quickwit");
    if (image === undefined) {
      throw new TypeError("CI image inventory must declare Quickwit");
    }
    expect(image.source).toBe(`docker.io/${composeImage}`);
  });
});
