import { sql } from "drizzle-orm";
import * as v from "valibot";

import {
  emailAddressSchema,
  emailColumnMatches,
  normalizeEmail,
} from "../../apps/api/src/lib/email/normalized-email";

declare const email: string;
declare const user: { email: string; name: string; id: string };
declare const profile: Record<string, string>;
declare const header: string;
declare const userTable: { email: ReturnType<typeof sql> };

// oxlint-disable-next-line no-adhoc-email-fold/no-adhoc-email-fold -- fixture proves a direct fold is reported
const _direct = email.toLowerCase();
// oxlint-disable-next-line no-adhoc-email-fold/no-adhoc-email-fold -- fixture proves a trimmed fold of a property is reported
const _trimmed = user.email.trim().toLowerCase();
// oxlint-disable-next-line no-adhoc-email-fold/no-adhoc-email-fold -- fixture proves a locale fold of an address property is reported
const _computed = profile.email.toLocaleLowerCase();
// oxlint-disable-next-line no-adhoc-email-fold/no-adhoc-email-fold -- fixture proves a lowercase action in an address schema is reported
const _schema = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email());
// oxlint-disable-next-line no-adhoc-email-fold/no-adhoc-email-fold -- fixture proves a hand-written SQL fold of an address column is reported
const _sql = sql`lower(${userTable.email}) = ${email}`;

// expect-clean: no-adhoc-email-fold/no-adhoc-email-fold
const _owned = normalizeEmail(email);
const _ownedSchema = emailAddressSchema;
const _ownedSql = emailColumnMatches(userTable.email, normalizeEmail(email));
const _name = user.name.toLowerCase();
const _header = header.trim().toLowerCase();
const _headerSchema = v.pipe(v.string(), v.trim(), v.toLowerCase());
const _sqlName = sql`lower(${user.name})`;
