import { sql } from "drizzle-orm";
import { check, numeric, pgTable, text } from "drizzle-orm/pg-core";

import {
  SESSION_SIGN_IN_REVIEW,
  SESSION_SIGN_IN_REVIEW_STATUSES,
} from "@stll/api-contract/session-sign-ins";
import type { CountryCode } from "@stll/country-codes";

import { session } from "@/api/db/auth-schema";
import { timestamptz } from "@/api/db/columns";
import { denyStellaAccessPolicies } from "@/api/db/rls";

import { stateFieldsCheck } from "../state-fields";

export const SESSION_SIGN_IN_LOCATION_KINDS = ["known", "unknown"] as const;

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

/**
 * What a session's sign-in looked like and whether its account holder has
 * recognised it. One row per session, written when the session is created and
 * deleted with it.
 *
 * The location is what CloudFront reported for the signing-in request and is
 * `unknown` whenever the request did not prove it came through CloudFront:
 * nothing here is inferred. Coordinates keep one decimal (about 11 km).
 */
export const sessionSignIns = pgTable(
  "session_sign_ins",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    /** Whether the edge reported a location; `unknown` leaves the rest null. */
    locationKind: text("location_kind", {
      enum: SESSION_SIGN_IN_LOCATION_KINDS,
    }).notNull(),
    countryCode: text("country_code").$type<CountryCode>(),
    region: text("region"),
    city: text("city"),
    latitude: numeric("latitude", { precision: 3, scale: 1, mode: "number" }),
    longitude: numeric("longitude", { precision: 4, scale: 1, mode: "number" }),
    /** Whether the sign-in waits for its account holder to recognise it. */
    review: text("review", { enum: SESSION_SIGN_IN_REVIEW_STATUSES })
      .notNull()
      .default(SESSION_SIGN_IN_REVIEW.notRequired),
    /** When the account holder confirmed the sign-in; set only while confirmed. */
    reviewedAt: timestamptz("reviewed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "session_sign_ins_review_check",
      sql`${table.review} IN (${sqlValues(SESSION_SIGN_IN_REVIEW_STATUSES)})`,
    ),
    stateFieldsCheck({
      name: "session_sign_ins_state_fields_check",
      state: table.review,
      rules: {
        not_required: { absent: [table.reviewedAt] },
        pending: { absent: [table.reviewedAt] },
        confirmed: { required: [table.reviewedAt] },
      },
    }),
    // A known location names its country; an unknown one carries nothing.
    check(
      "session_sign_ins_location_check",
      sql`(${table.locationKind} = 'unknown' AND ${table.countryCode} IS NULL AND ${table.region} IS NULL AND ${table.city} IS NULL AND ${table.latitude} IS NULL AND ${table.longitude} IS NULL) OR (${table.locationKind} = 'known' AND ${table.countryCode} ~ '^[A-Z]{2}$' AND (${table.latitude} IS NULL) = (${table.longitude} IS NULL))`,
    ),
    ...denyStellaAccessPolicies(),
  ],
);
