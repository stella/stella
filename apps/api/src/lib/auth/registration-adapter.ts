import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import type {
  DBAdapter,
  DBTransactionAdapter,
} from "@better-auth/core/db/adapter";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { Result } from "better-result";
import { getTableName } from "drizzle-orm";

import { authSchema } from "@/api/db/auth-schema";
import { tableRetention } from "@/api/db/retention";
import type { TableRetention } from "@/api/db/retention";
import { reserveRegistration } from "@/api/lib/auth/registration-budget";
import { isRecord } from "@/api/lib/type-guards";

export const REGISTRATION_RETENTION_SCHEMA_PLUGIN = {
  id: "registration-retention-schema",
  schema: {
    oauthClient: {
      fields: {
        registrationOrigin: {
          type: "string",
          input: false,
          required: true,
          defaultValue: "open-client",
        },
      },
    },
  },
} satisfies BetterAuthPlugin;

const modelTables = Object.fromEntries(
  Object.entries(authSchema).map(([model, table]) => [
    model,
    getTableName(table),
  ]),
);

type RequireAuthRetentionOptions = {
  model: string;
  tables?: Readonly<Record<string, string>>;
  lookup?: (table: string) => TableRetention | undefined;
};

export const requireAuthRetention = ({
  model,
  tables = modelTables,
  lookup = tableRetention,
}: RequireAuthRetentionOptions) => {
  const table = tables[model];
  if (!table) {
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "Database model requires a retention declaration.",
    });
  }
  const declaration = lookup(table);
  if (
    !declaration ||
    ("boundedBy" in declaration
      ? !declaration.boundedBy.trim()
      : !declaration.ttlColumn.trim() || !declaration.sweeper.trim())
  ) {
    throw new APIError("INTERNAL_SERVER_ERROR", {
      message: "Database model requires a retention declaration.",
    });
  }
  return table;
};

export const authorizationClientId = (data: Record<string, unknown>) => {
  const value = data["value"];
  if (typeof value !== "string" || !value.startsWith("{")) {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(value));
  if (
    Result.isError(parsed) ||
    !isRecord(parsed.value) ||
    parsed.value["type"] !== "authorization_code"
  ) {
    return undefined;
  }
  const query = parsed.value["query"];
  if (!isRecord(query) || typeof query["client_id"] !== "string") {
    throw new APIError("BAD_REQUEST", {
      message: "Authorization client is required.",
    });
  }
  return query["client_id"];
};

export const admitOpenClient = async (
  options: Omit<Parameters<typeof reserveRegistration>[0], "kind">,
) => {
  const admission = await reserveRegistration({
    ...options,
    kind: "open-client",
  });
  if (Result.isError(admission)) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: admission.error.message,
    });
  }
};

type WithAuthRetentionOptions = {
  adapter: DBAdapter;
  admitClient: () => Promise<void>;
  protectCreate?: (
    adapter: DBTransactionAdapter,
  ) => DBTransactionAdapter["create"];
  touchClient?: (clientId: string) => Promise<void>;
  retention?: (model: string) => string;
};

export const withAuthRetention = ({
  adapter,
  admitClient,
  protectCreate = (raw) => raw.create,
  touchClient,
  retention = (model) => requireAuthRetention({ model }),
}: WithAuthRetentionOptions): DBAdapter => {
  const protect = (raw: DBTransactionAdapter): DBTransactionAdapter => {
    const create = protectCreate(raw);
    return {
      ...raw,
      findOne: async <T>(args: Parameters<typeof raw.findOne>[0]) => {
        const row = await raw.findOne<T>(args);
        if (
          row === null ||
          !touchClient ||
          modelTables[args.model] !== "oauth_client"
        ) {
          return row;
        }
        const clientId = args.where.find(
          (condition) =>
            condition.field === "clientId" &&
            (!condition.operator || condition.operator === "eq"),
        )?.value;
        if (typeof clientId === "string") {
          await touchClient(clientId);
        }
        return row;
      },
      create: async (args) => {
        const table = retention(args.model);
        if (table !== "oauth_client") {
          return await create(args);
        }
        const path = tryGetCurrentAuthEndpointContext()?.path;
        const openClient =
          path === "/oauth2/register" ||
          typeof args.data["clientDiscoveryId"] === "string";
        if (!openClient) {
          if (
            path !== "/oauth2/create-client" &&
            path !== "/admin/oauth2/create-client"
          ) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Client registration requires a declared origin.",
            });
          }
          return await create({
            ...args,
            data: { ...args.data, registrationOrigin: "managed" },
          });
        }
        await admitClient();
        return await create({
          ...args,
          data: { ...args.data, registrationOrigin: "open-client" },
        });
      },
    };
  };
  return {
    ...protect(adapter),
    transaction: async (callback) =>
      await adapter.transaction(async (tx) => await callback(protect(tx))),
  };
};
