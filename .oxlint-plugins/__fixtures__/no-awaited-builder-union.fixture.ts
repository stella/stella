// Passive regression fixture for
// `no-awaited-builder-union/no-awaited-builder-union`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the fixture
// too.

type Rows = string[];

// Stands in for a Drizzle query builder: thenable, and every chain method
// returns another builder state.
type Builder = PromiseLike<Rows> & {
  for: (strength: string) => Builder;
  limit: (count: number) => Builder;
  offset: (count: number) => Builder;
  where: (clause: string) => Builder;
};

declare const query: Builder;
declare const otherQuery: Builder;
declare const buildQuery: () => Builder;
declare const loadRows: (page: number) => Promise<Rows>;
declare const rowsA: Promise<Rows>;
declare const rowsB: Promise<Rows>;
declare const lock: boolean;
declare const paged: boolean;

// MUST flag: one branch extends the shared root, the other does not.
export const lockedRows = async () => {
  // oxlint-disable-next-line no-awaited-builder-union/no-awaited-builder-union
  const rows = await (lock ? query.for("update") : query);
  return rows;
};

// MUST flag: both branches chain, with different chain shapes.
export const pagedRows = async () => {
  // oxlint-disable-next-line no-awaited-builder-union/no-awaited-builder-union
  const rows = await (paged ? query.limit(1) : query.limit(1).offset(2));
  return rows;
};

// MUST flag: a nested ternary is flattened to leaves that share one root.
export const nestedRows = async () => {
  // oxlint-disable-next-line no-awaited-builder-union/no-awaited-builder-union
  const rows = await (lock ? query : paged ? query.limit(1) : query.offset(2));
  return rows;
};

// MUST flag: a ternary wrapped in a TS-only expression is still a ternary.
export const pinnedRows = async () => {
  // oxlint-disable-next-line no-awaited-builder-union/no-awaited-builder-union
  const rows = await ((lock ? query.for("update") : query) satisfies Builder);
  return rows;
};

// MUST flag: a call-rooted chain unions the same way a bare identifier does.
export const builtRows = async () => {
  // oxlint-disable-next-line no-awaited-builder-union/no-awaited-builder-union
  const rows = await (lock ? buildQuery().for("update") : buildQuery());
  return rows;
};

// Allowed — the required rewrite: each branch is awaited on its own, so only
// one concrete builder type is ever resolved.
export const branchwiseRows = async () => {
  const rows = lock ? await query.for("update") : await query;
  return rows;
};

// Allowed — different roots. Two unrelated builders are not one builder's
// chain states, and flagging them would be noise.
export const twoBuilders = async () => {
  const rows = await (lock ? query.for("update") : otherQuery.limit(1));
  return rows;
};

// Allowed — no chains: two unrelated promises, not a builder union.
export const twoPromises = async () => {
  const rows = await (lock ? rowsA : rowsB);
  return rows;
};

// Allowed — the same call in both branches. The arguments differ but the
// chain shape does not, so there is one return type and no union.
export const twoPages = async () => {
  const rows = await (paged ? loadRows(1) : loadRows(2));
  return rows;
};

// Allowed — same chain shape, different arguments: one builder type.
export const twoFilters = async () => {
  const rows = await (lock ? query.where("a") : query.where("b"));
  return rows;
};

// Allowed — the ternary is never awaited, so nothing forces `Awaited<>` over
// the union here.
export const pickQuery = () => {
  const picked = lock ? query.for("update") : query;
  return picked;
};

// MUST flag: a builder held on an instance is the same union. A class-based
// query wrapper is exactly where this pattern hides.
class Repository {
  private readonly query!: Builder;

  async rows() {
    // oxlint-disable-next-line no-awaited-builder-union/no-awaited-builder-union
    return await (lock ? this.query.for("update") : this.query);
  }
}
export const repository = new Repository();

// MUST flag: a statically known computed key chains exactly like its dotted
// form, so these are two chain states and not one opaque `[]` step.
export const computedRows = async () => {
  // oxlint-disable-next-line no-awaited-builder-union/no-awaited-builder-union
  const rows = await (lock ? query["for"]("update") : query);
  return rows;
};

// Allowed — sibling paths off one object. Same root, different steps, but
// neither extends the other: ordinary code with two return types and no
// builder. Flagging these would block correct awaited ternaries.
declare const response: {
  json: () => Promise<Rows>;
  text: () => Promise<Rows>;
};
export const siblingCalls = async () => {
  const rows = await (lock ? response.json() : response.text());
  return rows;
};

declare const jobs: { primary: Promise<Rows>; secondary: Promise<Rows> };
export const siblingProperties = async () => {
  const rows = await (lock ? jobs.primary : jobs.secondary);
  return rows;
};
