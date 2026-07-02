import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const MANIFEST_PATH = "railway/template-manifest.json";
const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const RAILWAY_GRAPHQL_TIMEOUT_MS = 10_000;

class RailwayTemplateDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailwayTemplateDraftError";
  }
}

type ServiceTemplate = {
  requiredUserInputs: Record<string, string>;
  variables: Record<string, string>;
};

type TemplateManifest = {
  services: Record<string, ServiceTemplate>;
};

const failures: string[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const readJson = (filePath: string): unknown => {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new RailwayTemplateDraftError(
      `Failed to read or parse JSON file at ${filePath}: ${describeError(error)}`,
    );
  }
};

const getString = (value: Record<string, unknown>, key: string) => {
  const next = value[key];
  if (typeof next !== "string") {
    throw new RailwayTemplateDraftError(`${key} must be a string`);
  }
  return next;
};

const readStringRecord = (
  value: unknown,
  label: string,
): Record<string, string> => {
  if (!isRecord(value)) {
    throw new RailwayTemplateDraftError(`${label} must be an object`);
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new RailwayTemplateDraftError(`${label}.${key} must be a string`);
    }
    result[key] = item;
  }
  return result;
};

const readManifest = (): TemplateManifest => {
  const value = readJson(MANIFEST_PATH);
  if (!isRecord(value) || !isRecord(value["services"])) {
    throw new RailwayTemplateDraftError(
      `${MANIFEST_PATH} must define services`,
    );
  }

  const services: Record<string, ServiceTemplate> = {};
  for (const [serviceName, service] of Object.entries(value["services"])) {
    if (!isRecord(service)) {
      throw new RailwayTemplateDraftError(
        `${MANIFEST_PATH} service ${serviceName} must be an object`,
      );
    }
    services[serviceName] = {
      requiredUserInputs: readStringRecord(
        service["requiredUserInputs"] ?? {},
        `services.${serviceName}.requiredUserInputs`,
      ),
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
    throw new RailwayTemplateDraftError(
      "Set RAILWAY_API_TOKEN or log in with the Railway CLI first",
    );
  }

  const config = readJson(configPath);
  if (
    !isRecord(config) ||
    !isRecord(config["user"]) ||
    typeof config["user"]["accessToken"] !== "string"
  ) {
    throw new RailwayTemplateDraftError(
      "Railway CLI config does not include an access token",
    );
  }

  return config["user"]["accessToken"];
};

const graphql = async (
  token: string,
  query: string,
  variables: Record<string, unknown>,
) => {
  let response: Response;
  try {
    response = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(RAILWAY_GRAPHQL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RailwayTemplateDraftError(
      `Failed to connect to Railway GraphQL API: ${describeError(error)}`,
    );
  }

  if (!response.ok) {
    throw new RailwayTemplateDraftError(
      `Railway GraphQL request failed with status ${response.status}: ${response.statusText}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new RailwayTemplateDraftError(
      `Failed to parse Railway GraphQL response as JSON: ${describeError(error)}`,
    );
  }

  if (!isRecord(payload)) {
    throw new RailwayTemplateDraftError(
      "Railway GraphQL returned invalid JSON",
    );
  }
  const errors = payload["errors"];
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map((error) => {
      if (!isRecord(error) || typeof error["message"] !== "string") {
        return "Unknown Railway GraphQL error";
      }
      return error["message"];
    });
    throw new RailwayTemplateDraftError(messages.join("; "));
  }
  if (!isRecord(payload["data"])) {
    throw new RailwayTemplateDraftError("Railway GraphQL returned no data");
  }
  return payload["data"];
};

const normalizeTemplateValue = (value: string) =>
  value.replaceAll(/\$\{\{\s*/gu, "${{").replaceAll(/\s*\}\}/gu, "}}");

const sorted = (items: string[]) => [...items].sort();

const sameStringSet = (left: string[], right: string[]) =>
  JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));

const findServiceConfig = (
  servicesConfig: Record<string, unknown>,
  serviceName: string,
) => {
  for (const service of Object.values(servicesConfig)) {
    if (!isRecord(service) || service["name"] !== serviceName) {
      continue;
    }
    return service;
  }

  failures.push(`Template draft is missing service ${serviceName}`);
  return undefined;
};

const validateServiceVariables = ({
  draftService,
  serviceName,
  template,
}: {
  draftService: Record<string, unknown>;
  serviceName: string;
  template: ServiceTemplate;
}) => {
  const variablesConfig = draftService["variables"];
  if (!isRecord(variablesConfig)) {
    failures.push(`Template draft service ${serviceName} has no variables`);
    return;
  }

  const expectedPromptKeys = Object.keys(template.requiredUserInputs);
  const actualPromptKeys = Object.entries(variablesConfig)
    .filter(([, variable]) => {
      if (!isRecord(variable)) {
        return false;
      }
      return variable["isOptional"] !== true && !("defaultValue" in variable);
    })
    .map(([key]) => key);

  if (!sameStringSet(actualPromptKeys, expectedPromptKeys)) {
    failures.push(
      `${serviceName} prompts ${sorted(actualPromptKeys).join(", ") || "(none)"}; expected ${sorted(expectedPromptKeys).join(", ") || "(none)"}`,
    );
  }

  for (const [key, expectedValue] of Object.entries(template.variables)) {
    if (expectedPromptKeys.includes(key)) {
      continue;
    }

    const variable = variablesConfig[key];
    if (!isRecord(variable)) {
      failures.push(`${serviceName}.${key} is missing from the draft`);
      continue;
    }
    if (typeof variable["defaultValue"] !== "string") {
      failures.push(`${serviceName}.${key} must be prefilled in the draft`);
      continue;
    }
    if (
      normalizeTemplateValue(variable["defaultValue"]) !==
      normalizeTemplateValue(expectedValue)
    ) {
      failures.push(
        `${serviceName}.${key} has unexpected draft default ${variable["defaultValue"]}`,
      );
    }
  }
};

const printUsage = () => {
  console.log(
    "Usage: bun scripts/check-railway-template-draft.ts --template <template-id>",
  );
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      template: { type: "string", short: "t" },
    },
  });

  if (values.help) {
    printUsage();
    return;
  }

  const templateId = values.template?.trim();
  if (!templateId) {
    printUsage();
    throw new RailwayTemplateDraftError("--template is required");
  }

  const manifest = readManifest();
  const token = readRailwayToken();
  const data = await graphql(
    token,
    `
      query ($id: String!) {
        template(id: $id) {
          code
          id
          name
          serializedConfig
          status
        }
      }
    `,
    { id: templateId },
  );

  const template = data["template"];
  if (template === null || template === undefined) {
    throw new RailwayTemplateDraftError(
      `Railway template ${templateId} not found`,
    );
  }
  if (!isRecord(template)) {
    throw new RailwayTemplateDraftError(
      `Railway template ${templateId} returned invalid data`,
    );
  }
  if (!isRecord(template["serializedConfig"])) {
    throw new RailwayTemplateDraftError(
      `Railway template ${templateId} has no serialized config`,
    );
  }

  const servicesConfig = template["serializedConfig"]["services"];
  if (!isRecord(servicesConfig)) {
    throw new RailwayTemplateDraftError(
      `Railway template ${templateId} has no service config`,
    );
  }

  for (const [serviceName, serviceTemplate] of Object.entries(
    manifest.services,
  )) {
    const draftService = findServiceConfig(servicesConfig, serviceName);
    if (!draftService) {
      continue;
    }
    validateServiceVariables({
      draftService,
      serviceName,
      template: serviceTemplate,
    });
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`railway-template-draft: ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `railway-template-draft: ok (${getString(template, "name")}, ${getString(template, "status")})`,
  );
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
