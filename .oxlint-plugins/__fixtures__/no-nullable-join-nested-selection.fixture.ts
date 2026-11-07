// Passive regression fixture for
// `no-nullable-join-nested-selection/no-nullable-join-nested-selection`.
//
// Each `oxlint-disable-next-line` suppresses a shape the rule MUST report; if
// the detector regresses, the directive becomes unused and the fixture lint
// fails. Each `expect-clean` marks a shape the rule must NOT report.

type Column = { readonly name: string };
type Builder = {
  from: (table: unknown) => Builder;
  leftJoin: (table: unknown, on: unknown) => Builder;
  rightJoin: (table: unknown, on: unknown) => Builder;
  fullJoin: (table: unknown, on: unknown) => Builder;
  innerJoin: (table: unknown, on: unknown) => Builder;
  where: (condition: unknown) => Builder;
};

declare const db: {
  select: (selection?: unknown) => Builder;
  selectDistinct: (selection?: unknown) => Builder;
  selectDistinctOn: (on: unknown, selection?: unknown) => Builder;
};
declare const decisions: { id: Column; sourceId: Column; courtId: Column };
declare const sources: { id: Column; descriptor: Column };
declare const courts: { id: Column; name: Column };
declare const eq: (left: unknown, right: unknown) => unknown;

// A left-joined table nested: every NULL descriptor reads back as no source.
db.select({
  id: decisions.id,
  // oxlint-disable-next-line no-nullable-join-nested-selection/no-nullable-join-nested-selection -- fixture: nested over a left join
  source: { descriptor: sources.descriptor },
})
  .from(decisions)
  .leftJoin(sources, eq(sources.id, decisions.sourceId));

// The selection held in a const reaches the same check.
const selection = {
  id: decisions.id,
  // oxlint-disable-next-line no-nullable-join-nested-selection/no-nullable-join-nested-selection -- fixture: const selection
  source: { descriptor: sources.descriptor },
};
db.selectDistinct(selection)
  .from(decisions)
  .leftJoin(sources, eq(sources.id, decisions.sourceId));

// A right join makes the base table the nullable side.
db.select({
  // oxlint-disable-next-line no-nullable-join-nested-selection/no-nullable-join-nested-selection -- fixture: base table before a right join
  decision: { id: decisions.id },
  sourceId: sources.id,
})
  .from(decisions)
  .rightJoin(sources, eq(sources.id, decisions.sourceId));

// A full join makes both sides nullable.
db.selectDistinctOn([decisions.id], {
  // oxlint-disable-next-line no-nullable-join-nested-selection/no-nullable-join-nested-selection -- fixture: full join, base side
  decision: { id: decisions.id },
  // oxlint-disable-next-line no-nullable-join-nested-selection/no-nullable-join-nested-selection -- fixture: full join, joined side
  source: { descriptor: sources.descriptor },
})
  .from(decisions)
  .fullJoin(sources, eq(sources.id, decisions.sourceId));

// A column the left join matches with `eq` is never NULL on a matched row.
db.select({
  // expect-clean: no-nullable-join-nested-selection/no-nullable-join-nested-selection
  source: { id: sources.id, descriptor: sources.descriptor },
})
  .from(decisions)
  .leftJoin(sources, eq(sources.id, decisions.sourceId));

// A column that is not the join's key does not prove a match.
db.select({
  // oxlint-disable-next-line no-nullable-join-nested-selection/no-nullable-join-nested-selection -- fixture: id without a join on it
  source: { id: sources.id, descriptor: sources.descriptor },
})
  .from(decisions)
  .leftJoin(sources, eq(sources.descriptor, decisions.sourceId));

// Drizzle reads the first column: a key selected after it proves nothing.
db.select({
  // oxlint-disable-next-line no-nullable-join-nested-selection/no-nullable-join-nested-selection -- fixture: join key not first
  source: { descriptor: sources.descriptor, id: sources.id },
})
  .from(decisions)
  .leftJoin(sources, eq(sources.id, decisions.sourceId));

// An object reading two tables' columns is never nullified.
db.select({
  // expect-clean: no-nullable-join-nested-selection/no-nullable-join-nested-selection
  source: { decisionId: decisions.id, descriptor: sources.descriptor },
})
  .from(decisions)
  .leftJoin(sources, eq(sources.id, decisions.sourceId));

// The fix: flat columns, including the join key.
db.select({
  id: decisions.id,
  // expect-clean: no-nullable-join-nested-selection/no-nullable-join-nested-selection
  sourceId: sources.id,
  sourceDescriptor: sources.descriptor,
})
  .from(decisions)
  .leftJoin(sources, eq(sources.id, decisions.sourceId));

// Nested objects over the base table and an inner join are never nullified.
db.select({
  // expect-clean: no-nullable-join-nested-selection/no-nullable-join-nested-selection
  decision: { id: decisions.id },
  // expect-clean: no-nullable-join-nested-selection/no-nullable-join-nested-selection
  court: { name: courts.name },
  sourceDescriptor: sources.descriptor,
})
  .from(decisions)
  .innerJoin(courts, eq(courts.id, decisions.courtId))
  .leftJoin(sources, eq(sources.id, decisions.sourceId));

// No nullable join at all.
db.select({
  // expect-clean: no-nullable-join-nested-selection/no-nullable-join-nested-selection
  source: { descriptor: sources.descriptor },
})
  .from(sources)
  .where(eq(sources.id, decisions.sourceId));

// Drizzle nullifies only top-level nested objects.
db.select({
  // expect-clean: no-nullable-join-nested-selection/no-nullable-join-nested-selection
  meta: { source: { descriptor: sources.descriptor } },
})
  .from(decisions)
  .leftJoin(sources, eq(sources.id, decisions.sourceId));
