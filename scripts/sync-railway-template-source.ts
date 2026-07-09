import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const MANIFEST_PATH = "railway/template-manifest.json";
const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const RAILWAY_GRAPHQL_TIMEOUT_MS = 10_000;
const DEFAULT_ENVIRONMENT = "production";
const TEMPLATE_FUNCTION_PATTERN = /\$\{\{\s*(?:secret|randomInt)\(/u;
const SERVICE_NAMES = {
  api: "api",
  gotenberg: "gotenberg",
  postgres: "Postgres",
  redis: "Redis",
} as const;

class RailwayTemplateSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailwayTemplateSyncError";
  }
}

type ServiceTemplate = {
  variables: Record<string, string>;
};

type TemplateManifest = {
  services: Record<string, ServiceTemplate>;
};

type GraphqlResponse<TData> = {
  data?: TData;
  errors?: { message: string }[];
};

type ProjectQueryData = {
  project: {
    id: string;
    name: string;
    environments: {
      edges: {
        node: {
          id: string;
          name: string;
          serviceInstances: {
            edges: {
              node: {
                serviceId: string;
                serviceName: string;
              };
            }[];
          };
        };
      }[];
    };
  } | null;
};

type VariablesQueryData = {
  variables: Record<string, string>;
};

type VariableCollectionUpsertData = {
  variableCollectionUpsert: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (filePath: string): unknown =>
  JSON.parse(readFileSync(filePath, "utf-8"));

const readStringRecord = (
  value: unknown,
  label: string,
): Record<string, string> => {
  if (!isRecord(value)) {
    throw new RailwayTemplateSyncError(`${label} must be an object`);
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new RailwayTemplateSyncError(`${label}.${key} must be a string`);
    }
    result[key] = item;
  }
  return result;
};

const readManifest = (): TemplateManifest => {
  const value = readJson(MANIFEST_PATH);
  if (!isRecord(value) || !isRecord(value["services"])) {
    throw new RailwayTemplateSyncError(`${MANIFEST_PATH} must define services`);
  }

  const services: Record<string, ServiceTemplate> = {};
  for (const [serviceName, service] of Object.entries(value["services"])) {
    if (!isRecord(service)) {
      throw new RailwayTemplateSyncError(
        `${MANIFEST_PATH} service ${serviceName} must be an object`,
      );
    }
    services[serviceName] = {
      variables: readStringRecord(
        service["variables"] ?? {},
        `services.${serviceName}.variables`,
      ),
    };
  }

  return { services };
};

const readRailwayToken = () => {
  const fromEnv = process.env["RAILWAY_API_TOKEN"]?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const configPath = path.join(homedir(), ".railway", "config.json");
  if (!existsSync(configPath)) {
    throw new RailwayTemplateSyncError(
      "Set RAILWAY_API_TOKEN or log in with the Railway CLI first",
    );
  }

  const config = readJson(configPath);
  if (
    !isRecord(config) ||
    !isRecord(config["user"]) ||
    typeof config["user"]["accessToken"] !== "string"
  ) {
    throw new RailwayTemplateSyncError(
      "Railway CLI config does not include an access token",
    );
  }

  return config["user"]["accessToken"];
};

const graphql = async <TData>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
) => {
  const response = await fetch(RAILWAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(RAILWAY_GRAPHQL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new RailwayTemplateSyncError(
      `Railway GraphQL request failed with status ${response.status}: ${response.statusText}`,
    );
  }

  // SAFETY: Railway GraphQL validates the response shape for the query; callers
  // provide the matching data type for the query document they pass here.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  const payload = (await response.json()) as GraphqlResponse<TData>;
  if (payload.errors && payload.errors.length > 0) {
    throw new RailwayTemplateSyncError(
      payload.errors.map((error) => error.message).join("; "),
    );
  }
  if (!payload.data) {
    throw new RailwayTemplateSyncError("Railway GraphQL returned no data");
  }
  return payload.data;
};

type ResolvedProject = {
  environmentId: string;
  environmentName: string;
  projectName: string;
  serviceIdsByName: Map<string, string>;
};

const resolveProject = async ({
  token,
  projectId,
  environment,
}: {
  token: string;
  projectId: string;
  environment: string;
}): Promise<ResolvedProject> => {
  const data = await graphql<ProjectQueryData>(
    token,
    `
      query ($projectId: String!) {
        project(id: $projectId) {
          id
          name
          environments {
            edges {
              node {
                id
                name
                serviceInstances {
                  edges {
                    node {
                      serviceId
                      serviceName
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { projectId },
  );

  if (!data.project) {
    throw new RailwayTemplateSyncError(
      `Railway project not found: ${projectId}`,
    );
  }

  const selectedEnvironment = data.project.environments.edges
    .map((edge) => edge.node)
    .find((node) => node.id === environment || node.name === environment);

  if (!selectedEnvironment) {
    throw new RailwayTemplateSyncError(
      `Environment ${environment} not found in ${data.project.name}`,
    );
  }

  return {
    environmentId: selectedEnvironment.id,
    environmentName: selectedEnvironment.name,
    projectName: data.project.name,
    serviceIdsByName: new Map(
      selectedEnvironment.serviceInstances.edges.map((edge) => [
        edge.node.serviceName,
        edge.node.serviceId,
      ]),
    ),
  };
};

const readVariables = async ({
  token,
  projectId,
  environmentId,
  serviceId,
  unrendered = true,
}: {
  token: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  unrendered?: boolean;
}) => {
  const data = await graphql<VariablesQueryData>(
    token,
    `
      query (
        $projectId: String!
        $environmentId: String!
        $serviceId: String!
        $unrendered: Boolean!
      ) {
        variables(
          projectId: $projectId
          environmentId: $environmentId
          serviceId: $serviceId
          unrendered: $unrendered
        )
      }
    `,
    { environmentId, projectId, serviceId, unrendered },
  );

  return data.variables;
};

const requireServiceId = (
  serviceIdsByName: Map<string, string>,
  serviceName: string,
  projectName: string,
) => {
  const serviceId = serviceIdsByName.get(serviceName);
  if (!serviceId) {
    throw new RailwayTemplateSyncError(
      `Service ${serviceName} not found in ${projectName}`,
    );
  }
  return serviceId;
};

const writeVariables = async ({
  token,
  projectId,
  environmentId,
  serviceId,
  variables,
  prune,
}: {
  token: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  variables: Record<string, string>;
  prune: boolean;
}) => {
  const data = await graphql<VariableCollectionUpsertData>(
    token,
    `
      mutation ($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `,
    {
      input: {
        environmentId,
        projectId,
        replace: prune,
        serviceId,
        skipDeploys: true,
        variables,
      },
    },
  );

  if (!data.variableCollectionUpsert) {
    throw new RailwayTemplateSyncError("Railway variable sync returned false");
  }
};

const diffVariables = ({
  current,
  desired,
  prune,
}: {
  current: Record<string, string>;
  desired: Record<string, string>;
  prune: boolean;
}) => {
  const set = Object.entries(desired)
    .filter(([key, value]) => current[key] !== value)
    .map(([key]) => key)
    .sort();
  const remove = prune
    ? Object.keys(current)
        .filter((key) => !(key in desired))
        .sort()
    : [];

  return { remove, set };
};

const hasTemplateFunction = (variables: Record<string, string>) =>
  Object.values(variables).some((value) =>
    TEMPLATE_FUNCTION_PATTERN.test(value),
  );

const extractUrlPassword = (value: string | undefined, label: string) => {
  if (!value) {
    throw new RailwayTemplateSyncError(`${label} is missing`);
  }

  try {
    const url = new URL(value);
    if (!url.password) {
      throw new RailwayTemplateSyncError(`${label} has no password`);
    }
    return decodeURIComponent(url.password);
  } catch (error) {
    if (error instanceof RailwayTemplateSyncError) {
      throw error;
    }
    throw new RailwayTemplateSyncError(`${label} is not a valid URL`);
  }
};

const assertSameSecret = (
  label: string,
  values: Record<string, string | undefined>,
) => {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw new RailwayTemplateSyncError(`${label} has no values to compare`);
  }

  const first = entries.at(0);
  if (!first) {
    throw new RailwayTemplateSyncError(`${label} has no values to compare`);
  }
  const [firstKey, firstValue] = first;
  if (!firstValue) {
    throw new RailwayTemplateSyncError(`${label} missing ${firstKey}`);
  }

  for (const [key, value] of entries.slice(1)) {
    if (!value) {
      throw new RailwayTemplateSyncError(`${label} missing ${key}`);
    }
    if (value !== firstValue) {
      throw new RailwayTemplateSyncError(
        `${label} rendered credentials disagree: ${firstKey} does not match ${key}`,
      );
    }
  }
};

const checkRenderedCredentials = async ({
  token,
  projectId,
  resolvedProject,
}: {
  token: string;
  projectId: string;
  resolvedProject: ResolvedProject;
}) => {
  const readRendered = async (serviceName: string) =>
    await readVariables({
      environmentId: resolvedProject.environmentId,
      projectId,
      serviceId: requireServiceId(
        resolvedProject.serviceIdsByName,
        serviceName,
        resolvedProject.projectName,
      ),
      token,
      unrendered: false,
    });

  const postgres = await readRendered(SERVICE_NAMES.postgres);
  const redis = await readRendered(SERVICE_NAMES.redis);
  const api = await readRendered(SERVICE_NAMES.api);
  const gotenberg = await readRendered(SERVICE_NAMES.gotenberg);

  assertSameSecret("Postgres password", {
    "Postgres.DATABASE_PUBLIC_URL password": extractUrlPassword(
      postgres["DATABASE_PUBLIC_URL"],
      "Postgres.DATABASE_PUBLIC_URL",
    ),
    "Postgres.DATABASE_URL password": extractUrlPassword(
      postgres["DATABASE_URL"],
      "Postgres.DATABASE_URL",
    ),
    "Postgres.PGPASSWORD": postgres["PGPASSWORD"],
    "Postgres.POSTGRES_PASSWORD": postgres["POSTGRES_PASSWORD"],
    "api.DATABASE_URL password": extractUrlPassword(
      api["DATABASE_URL"],
      "api.DATABASE_URL",
    ),
  });

  assertSameSecret("Redis password", {
    "Redis.REDIS_PUBLIC_URL password": extractUrlPassword(
      redis["REDIS_PUBLIC_URL"],
      "Redis.REDIS_PUBLIC_URL",
    ),
    "Redis.REDIS_URL password": extractUrlPassword(
      redis["REDIS_URL"],
      "Redis.REDIS_URL",
    ),
    "Redis.REDISPASSWORD": redis["REDISPASSWORD"],
    "Redis.REDIS_PASSWORD": redis["REDIS_PASSWORD"],
    "api.REDIS_URL password": extractUrlPassword(
      api["REDIS_URL"],
      "api.REDIS_URL",
    ),
  });

  assertSameSecret("Gotenberg username", {
    "api.GOTENBERG_USERNAME": api["GOTENBERG_USERNAME"],
    "gotenberg.GOTENBERG_API_BASIC_AUTH_USERNAME":
      gotenberg["GOTENBERG_API_BASIC_AUTH_USERNAME"],
  });

  assertSameSecret("Gotenberg password", {
    "api.GOTENBERG_PASSWORD": api["GOTENBERG_PASSWORD"],
    "gotenberg.GOTENBERG_API_BASIC_AUTH_PASSWORD":
      gotenberg["GOTENBERG_API_BASIC_AUTH_PASSWORD"],
  });
};

const main = async () => {
  const {
    values: {
      apply,
      "check-rendered-credentials": checkRenderedCredentialsOnly,
      environment,
      project,
      prune,
      "template-source": templateSource,
    },
  } = parseArgs({
    options: {
      apply: { type: "boolean" },
      "check-rendered-credentials": { type: "boolean" },
      environment: { type: "string" },
      project: { type: "string" },
      prune: { type: "boolean" },
      "template-source": { type: "boolean" },
    },
  });

  const projectId = project ?? process.env["RAILWAY_TEMPLATE_PROJECT_ID"];
  if (!projectId) {
    throw new RailwayTemplateSyncError(
      "Pass --project or set RAILWAY_TEMPLATE_PROJECT_ID",
    );
  }

  const manifest = readManifest();
  const token = readRailwayToken();
  const resolvedProject = await resolveProject({
    token,
    projectId,
    environment:
      environment ??
      process.env["RAILWAY_TEMPLATE_ENVIRONMENT"] ??
      DEFAULT_ENVIRONMENT,
  });

  if (checkRenderedCredentialsOnly) {
    await checkRenderedCredentials({ projectId, resolvedProject, token });
    console.log("railway-template-source: rendered credentials ok");
    return;
  }

  console.log(
    `railway-template-source: ${apply ? "apply variables" : "dry-run variables"} ${resolvedProject.projectName}/${resolvedProject.environmentName}`,
  );

  let hasDrift = false;
  for (const [serviceName, service] of Object.entries(manifest.services)) {
    const serviceId = requireServiceId(
      resolvedProject.serviceIdsByName,
      serviceName,
      resolvedProject.projectName,
    );

    if (apply && hasTemplateFunction(service.variables) && !templateSource) {
      throw new RailwayTemplateSyncError(
        `${serviceName} variables contain template functions. Re-run with --template-source only for a project dedicated to template generation.`,
      );
    }

    // eslint-disable-next-line no-await-in-loop -- diff output is intentionally ordered by service for operator review.
    const current = await readVariables({
      token,
      projectId,
      environmentId: resolvedProject.environmentId,
      serviceId,
    });
    const diff = diffVariables({
      current,
      desired: service.variables,
      prune: prune ?? false,
    });

    if (diff.set.length === 0 && diff.remove.length === 0) {
      console.log(`${serviceName}: variables ok`);
      continue;
    }

    hasDrift = true;
    if (diff.set.length > 0) {
      console.log(`${serviceName}: variables set ${diff.set.join(", ")}`);
    }
    if (diff.remove.length > 0) {
      console.log(`${serviceName}: variables remove ${diff.remove.join(", ")}`);
    }

    if (apply) {
      // eslint-disable-next-line no-await-in-loop -- service variable writes are intentionally sequential to keep Railway changes easy to audit.
      await writeVariables({
        token,
        projectId,
        environmentId: resolvedProject.environmentId,
        serviceId,
        variables: service.variables,
        prune: prune ?? false,
      });
      console.log(`${serviceName}: variables synced`);
    }
  }

  if (!apply) {
    if (hasDrift) {
      throw new RailwayTemplateSyncError(
        "Dry run found variable drift. Re-run with --apply to sync it.",
      );
    }
    console.log(
      "railway-template-source: dry-run only; pass --apply to mutate",
    );
  }
  console.log(
    "railway-template-source: variable sync only; verify buckets, networking, and service config files in Railway before publishing",
  );
  console.log("railway-template-source: variables ok");
};

await main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`railway-template-source: ${error.message}`);
  } else {
    console.error(`railway-template-source: ${String(error)}`);
  }
  process.exit(1);
});
