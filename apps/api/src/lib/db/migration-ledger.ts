import { panic } from "better-result";
import type { MigrationMeta } from "drizzle-orm/migrator";

type BundleMigration = Pick<
  MigrationMeta,
  "name" | "hash" | "folderMillis" | "sql"
>;

type MigrationAlias = {
  fileName: string;
  priorHash: string;
  newHash: string;
};

type LedgerReceipt = {
  id: number;
  hash: string;
  created_at: string | number | bigint | null;
  name: string | null;
};

type LedgerOptions = {
  rows: readonly LedgerReceipt[];
  bundle: readonly BundleMigration[];
  inventory: readonly MigrationAlias[];
};

type AdoptionDecision =
  | {
      type: "mapped";
      receipt: LedgerReceipt;
      name: string;
      matchedBy: "name" | "hash" | "timestamp";
    }
  | { type: "unmapped"; receipt: LedgerReceipt; candidateNames: readonly [] }
  | { type: "unknown"; receipt: LedgerReceipt }
  | {
      type: "ambiguous";
      receipt: LedgerReceipt;
      candidateNames: readonly string[];
    };

const acceptedHashes = (
  migration: BundleMigration,
  inventory: readonly MigrationAlias[],
): ReadonlySet<string> => {
  const accepted = new Set([migration.hash]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of inventory) {
      if (
        alias.fileName === migration.name &&
        accepted.has(alias.newHash) &&
        !accepted.has(alias.priorHash)
      ) {
        accepted.add(alias.priorHash);
        changed = true;
      }
    }
  }
  return accepted;
};

export const planLedgerAdoption = ({
  rows,
  bundle,
  inventory,
}: LedgerOptions): AdoptionDecision[] => {
  const byName = new Map(
    bundle.map((migration) => [migration.name, migration]),
  );
  const byHash = new Map<string, BundleMigration[]>();
  for (const migration of bundle) {
    for (const hash of acceptedHashes(migration, inventory)) {
      const candidates = byHash.get(hash);
      if (candidates === undefined) {
        byHash.set(hash, [migration]);
      } else {
        candidates.push(migration);
      }
    }
  }

  return rows.map((receipt) => {
    if (receipt.name !== null) {
      const named = byName.get(receipt.name);
      if (named === undefined) {
        return { type: "unknown", receipt };
      }
      return {
        type: "mapped",
        receipt,
        name: named.name,
        matchedBy: "name",
      };
    }

    const candidates = byHash.get(receipt.hash) ?? [];
    const soleCandidate = candidates.at(0);
    if (candidates.length === 1 && soleCandidate !== undefined) {
      return {
        type: "mapped",
        receipt,
        name: soleCandidate.name,
        matchedBy: "hash",
      };
    }
    if (candidates.length > 1) {
      const timestampMatches = candidates.filter(
        ({ folderMillis }) =>
          String(folderMillis) === String(receipt.created_at),
      );
      const timestampMatch = timestampMatches.at(0);
      if (timestampMatches.length === 1 && timestampMatch !== undefined) {
        return {
          type: "mapped",
          receipt,
          name: timestampMatch.name,
          matchedBy: "timestamp",
        };
      }
      return {
        type: "ambiguous",
        receipt,
        candidateNames: candidates.map(({ name }) => name),
      };
    }
    return { type: "unmapped", receipt, candidateNames: [] };
  });
};

type LedgerViolation =
  | { type: "null-name"; rowId: number }
  | { type: "duplicate-name"; name: string; rowIds: readonly number[] }
  | {
      type: "ambiguous-adoption";
      rowId: number;
      candidateNames: readonly string[];
    }
  | { type: "unknown-name"; rowId: number; name: string; pending: boolean }
  | { type: "hash-mismatch"; rowId: number; name: string; hash: string };

export const validateLedger = ({
  receipts,
  bundle,
  inventory,
}: {
  receipts: readonly LedgerReceipt[];
  bundle: readonly BundleMigration[];
  inventory: readonly MigrationAlias[];
}): LedgerViolation[] => {
  const decisions = planLedgerAdoption({ rows: receipts, bundle, inventory });
  const bundledByName = new Map(
    bundle.map((migration) => [migration.name, migration]),
  );
  const appliedNames = new Set<string>();
  const receiptIdsByName = new Map<string, number[]>();
  const violations: LedgerViolation[] = [];

  for (const decision of decisions) {
    const { receipt } = decision;
    let name = receipt.name;
    if (receipt.name === null) {
      switch (decision.type) {
        case "mapped":
          name = decision.name;
          break;
        case "unmapped":
          violations.push({ type: "null-name", rowId: receipt.id });
          continue;
        case "ambiguous":
          violations.push({
            type: "ambiguous-adoption",
            rowId: receipt.id,
            candidateNames: decision.candidateNames,
          });
          continue;
        case "unknown":
          return panic("Named migration adoption decision for a NULL receipt");
        default: {
          decision satisfies never;
          panic("Unexpected migration adoption decision");
        }
      }
    }
    if (name === null) {
      continue;
    }
    const ids = receiptIdsByName.get(name);
    if (ids === undefined) {
      receiptIdsByName.set(name, [receipt.id]);
    } else {
      ids.push(receipt.id);
    }
    if (bundledByName.has(name)) {
      appliedNames.add(name);
    }
  }

  const pending = bundle.some(({ name }) => !appliedNames.has(name));
  for (const receipt of receipts) {
    if (receipt.name === null) {
      continue;
    }
    const migration = bundledByName.get(receipt.name);
    if (migration === undefined) {
      violations.push({
        type: "unknown-name",
        rowId: receipt.id,
        name: receipt.name,
        pending,
      });
      continue;
    }
    if (!acceptedHashes(migration, inventory).has(receipt.hash)) {
      violations.push({
        type: "hash-mismatch",
        rowId: receipt.id,
        name: receipt.name,
        hash: receipt.hash,
      });
    }
  }
  for (const [name, rowIds] of receiptIdsByName) {
    if (rowIds.length > 1) {
      violations.push({ type: "duplicate-name", name, rowIds });
    }
  }
  return violations;
};

const FOLDER_NAME = /^[0-9]{14}_[a-z0-9_-]+$/u;
const REQUIRES_LINE = /^\s*--\s*requires:\s*(.*)$/u;

type RequiresLine = { line: number; value: string };

type ParsedRequiresHeader = {
  dependencies: readonly string[];
  lines: readonly RequiresLine[];
};

const scanRequiresLines = (sqlText: string) => {
  const headerLines: RequiresLine[] = [];
  const malformedLines: RequiresLine[] = [];
  const misplacedLines: RequiresLine[] = [];
  let inLeadingComments = true;

  for (const [index, line] of sqlText.split(/\r?\n/u).entries()) {
    if (line.trim() === "") {
      continue;
    }
    if (!/^\s*--/u.test(line)) {
      inLeadingComments = false;
    }
    const value = REQUIRES_LINE.exec(line)?.at(1);
    if (value === undefined) {
      continue;
    }
    const requiresLine = { line: index + 1, value: value.trim() };
    if (!FOLDER_NAME.test(requiresLine.value)) {
      malformedLines.push(requiresLine);
    } else if (!inLeadingComments) {
      misplacedLines.push(requiresLine);
    } else {
      headerLines.push(requiresLine);
    }
  }
  return { headerLines, malformedLines, misplacedLines };
};

export const parseRequiresHeader = (sqlText: string): ParsedRequiresHeader => {
  const { headerLines } = scanRequiresLines(sqlText);
  return {
    dependencies: headerLines.map(({ value }) => value),
    lines: headerLines,
  };
};

type MalformedRequiresLine = RequiresLine & {
  type: "malformed-requires" | "misplaced-requires";
};

export const findMalformedRequiresLines = (
  sqlText: string,
): MalformedRequiresLine[] => {
  const { malformedLines, misplacedLines } = scanRequiresLines(sqlText);
  return [
    ...malformedLines.map(({ line, value }) => ({
      type: "malformed-requires" as const,
      line,
      value,
    })),
    ...misplacedLines.map(({ line, value }) => ({
      type: "misplaced-requires" as const,
      line,
      value,
    })),
  ].toSorted((left, right) => left.line - right.line);
};

type RequiresViolation =
  | { type: "requires-missing"; name: string; dependency: string }
  | { type: "requires-self"; name: string }
  | { type: "requires-order"; name: string; dependency: string }
  | { type: "requires-cycle"; cycle: readonly string[] };

export const validateRequires = ({
  bundle,
  appliedNames,
}: {
  bundle: readonly BundleMigration[];
  appliedNames: ReadonlySet<string>;
}): RequiresViolation[] => {
  const indexByName = new Map(bundle.map(({ name }, index) => [name, index]));
  const dependenciesByName = new Map(
    bundle.map(({ name, sql }) => [
      name,
      parseRequiresHeader(sql.join("--> statement-breakpoint")).dependencies,
    ]),
  );
  const violations: RequiresViolation[] = [];

  for (const [index, migration] of bundle.entries()) {
    for (const dependency of dependenciesByName.get(migration.name) ?? []) {
      const dependencyIndex = indexByName.get(dependency);
      if (dependencyIndex === undefined) {
        violations.push({
          type: "requires-missing",
          name: migration.name,
          dependency,
        });
        continue;
      }
      if (dependency === migration.name) {
        violations.push({ type: "requires-self", name: migration.name });
        continue;
      }
      if (!appliedNames.has(dependency) && dependencyIndex >= index) {
        violations.push({
          type: "requires-order",
          name: migration.name,
          dependency,
        });
      }
    }
  }

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const reportedCycles = new Set<string>();
  const visit = (name: string): void => {
    if (state.get(name) === "done") {
      return;
    }
    if (state.get(name) === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(name)), name];
      const key = cycle.slice(0, -1).toSorted().join("\0");
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        violations.push({ type: "requires-cycle", cycle });
      }
      return;
    }
    state.set(name, "visiting");
    stack.push(name);
    for (const dependency of dependenciesByName.get(name) ?? []) {
      if (indexByName.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(name, "done");
  };
  for (const { name } of bundle) {
    visit(name);
  }
  return violations;
};

export const findSortUnstableNames = ({
  bundle,
  addedNames,
}: {
  bundle: readonly BundleMigration[];
  addedNames: ReadonlySet<string>;
}): string[] => {
  const drizzleNames = bundle.map(({ name }) => name);
  const codepointNames = drizzleNames.toSorted();
  return drizzleNames.filter(
    (name, index) => addedNames.has(name) && codepointNames[index] !== name,
  );
};
