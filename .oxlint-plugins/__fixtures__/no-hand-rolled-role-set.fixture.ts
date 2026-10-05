// Passive regression fixture for
// `no-hand-rolled-role-set/no-hand-rolled-role-set`.
//
// Each `oxlint-disable-next-line` below suppresses a case the rule MUST flag:
// a list of organization roles spelled outside the owning modules. If the rule
// regresses, the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The accepted
// forms carry no directive, so a rule that over-reports fails here too.

import { sql } from "drizzle-orm";

declare const role: string;
declare const actorRole: string;
declare const managementRoles: readonly string[];

// oxlint-disable-next-line no-hand-rolled-role-set/no-hand-rolled-role-set
const _either = role === "owner" || role === "admin";

// oxlint-disable-next-line no-hand-rolled-role-set/no-hand-rolled-role-set
const _neither = role !== "owner" && role !== "admin";

// oxlint-disable-next-line no-hand-rolled-role-set/no-hand-rolled-role-set
const _included = ["owner", "admin"].includes(role);

// oxlint-disable-next-line no-hand-rolled-role-set/no-hand-rolled-role-set
const _sqlList = sql`SELECT 1 FROM member m WHERE m.role IN ('owner', 'admin')`;

// oxlint-disable-next-line no-hand-rolled-role-set/no-hand-rolled-role-set
const _sqlArray = "SELECT 1 WHERE role = ANY (ARRAY['owner'::text,'admin'])";

// One role is not a set.
const _ownerOnly = role === "owner";

// Two operands, so no single value is tested against a set.
// expect-clean: no-hand-rolled-role-set/no-hand-rolled-role-set
const _actorIsOwner = role !== "owner" || actorRole === "owner";

// The owner's set, read by name.
const _managed = managementRoles.some((candidate) => candidate === role);

// Not every element is a role.
const _mixed = ["owner", "draft"];

// One quoted role in SQL text.
const _sqlOwner = sql`SELECT 1 FROM member m WHERE m.role = 'owner'`;
