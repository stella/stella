import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  propertyStatusEnum,
  relations,
  timeEntrySourceEnum,
  timeEntryStatusEnum,
} from "@/api/db/schema";
import { env } from "@/api/env";

// https://github.com/drizzle-team/drizzle-orm/issues/4942
// const client = new SQL(env.DATABASE_URL);

export const db = drizzle(env.DATABASE_URL, {
  relations: { ...relations, ...authRelationsPart },
  schema: {
    propertyStatusEnum,
    timeEntryStatusEnum,
    timeEntrySourceEnum,
  },
});

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
