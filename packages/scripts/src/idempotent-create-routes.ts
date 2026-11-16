import { panic } from "better-result";

type MountedRoute = {
  method: string;
  path: string;
  definition: { config: Readonly<Record<string, unknown>> };
};
type CreateEndpoint = {
  file: string;
  definition: object;
  create: boolean;
};

export const CREATE_ROUTES_MARKER = "STELLA_CREATE_ROUTES=";

export type IdempotentCreateRoute = {
  method: "POST" | "PUT";
  path: string;
  file: string;
  replay: boolean;
};

type CollectIdempotentCreateRoutesOptions = {
  routes: readonly MountedRoute[];
  endpoints: readonly CreateEndpoint[];
};

/** Join the served definitions to their canonical handler owners by identity. */
export const collectIdempotentCreateRoutes = ({
  routes,
  endpoints,
}: CollectIdempotentCreateRoutesOptions): IdempotentCreateRoute[] => {
  const owners = new Map(
    endpoints.map((endpoint) => [endpoint.definition, endpoint]),
  );
  return routes.flatMap(({ method, path, definition }) => {
    const owner = owners.get(definition);
    if ((method !== "POST" && method !== "PUT") || !owner?.create) {
      return [];
    }
    const idempotency = definition.config["idempotency"];
    return [
      {
        method,
        path,
        file: owner.file,
        replay:
          typeof idempotency === "object" &&
          idempotency !== null &&
          "type" in idempotency &&
          idempotency.type === "replay",
      },
    ];
  });
};

const isCreateRoute = (row: unknown): row is IdempotentCreateRoute =>
  typeof row === "object" &&
  row !== null &&
  "method" in row &&
  (row.method === "POST" || row.method === "PUT") &&
  "path" in row &&
  typeof row.path === "string" &&
  "file" in row &&
  typeof row.file === "string" &&
  "replay" in row &&
  typeof row.replay === "boolean";

/** Validate the subprocess projection at its JSON boundary. */
export const parseIdempotentCreateRoutes = (
  value: unknown,
): IdempotentCreateRoute[] => {
  if (!Array.isArray(value) || !value.every(isCreateRoute)) {
    return panic("Invalid mounted create route projection");
  }
  return value;
};
