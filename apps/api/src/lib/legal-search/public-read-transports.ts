import type { Fetcher, FetchWithTimeoutInit } from "@stll/fetch";

export type PublicReadIoMethods<Database, Tx> = {
  readTransaction: <T>(
    database: Database,
    run: (tx: Tx) => Promise<T>,
  ) => Promise<T>;
  fetch: <T>(
    input: string | URL | Request,
    init: FetchWithTimeoutInit,
    consume: (response: Response) => T | Promise<T>,
    fetcher?: Fetcher,
  ) => Promise<T>;
  fetchStream: (
    input: string | URL | Request,
    init: FetchWithTimeoutInit,
    fetcher?: Fetcher,
  ) => Promise<Response>;
};

export const PUBLIC_READ_IO_METHODS = {
  readTransaction: "database",
  fetch: "http",
  fetchStream: "http",
} as const satisfies Record<
  keyof PublicReadIoMethods<never, never>,
  "http" | "database"
>;

export const PUBLIC_READ_TRANSPORTS = {
  database: ["apps/api/src/lib/public-law-read-db.ts"],
  "corpus-index": ["apps/api/src/lib/legal-search/corpus-index-client.ts"],
  "object-storage": ["apps/api/src/lib/s3.ts"],
  publisher: ["apps/api/src/handlers/case-law/ingestion/adapters/retry.ts"],
  development: ["apps/api/src/handlers/case-law/decisions/dev-reparse.ts"],
  hydration: [
    "apps/api/src/handlers/case-law/decisions/document-on-demand.ts",
    "apps/api/src/handlers/case-law/decisions/document-on-demand-deps.ts",
  ],
} as const;

export type PublicReadTransport = keyof typeof PUBLIC_READ_TRANSPORTS;
