// Passive regression fixture for
// `no-known-value-widening/no-known-value-widening`.
// Every suppression below must remain used; a rule regression therefore fails
// through Oxlint's unused-directive check.

type Command = () => void;
declare const startCommand: Command;
type OpenCommands = Record<string, Command>;
type FiniteCommands = Record<"start" | "stop", Command>;

// Known object evidence is discarded by a broad annotation.
// oxlint-disable-next-line no-known-value-widening/no-known-value-widening -- fixture: the known shape must not be erased
const unknownValue: unknown = { id: "known" };

// Aliased open dictionaries are still broad targets.
// oxlint-disable-next-line no-known-value-widening/no-known-value-widening -- fixture: an open key space discards known keys
const openCommands: OpenCommands = { start: startCommand };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture exercises the widening before the independently guarded narrowing
const narrowedCommands = openCommands as { readonly start: Command };

// An explicit broad assertion has the same evidence-loss problem.
// oxlint-disable-next-line no-known-value-widening/no-known-value-widening -- fixture: a broad assertion must not erase the literal shape
const assertedValue = { id: "known" } as unknown;

// Return annotations and parameters are intentionally not checked: API and
// serializer contracts may need to expose broad types.
const createUnknown = (): unknown => ({ id: "known" });

// Empty dynamic dictionaries are legitimate accumulators.
const emptyCommands: Record<string, Command> = {};

// Finite records preserve their key evidence and remain exhaustive.
const finiteCommands: FiniteCommands = {
  start: startCommand,
  stop: startCommand,
};

// Runtime and imported boundaries have no local evidence for this rule.
declare function loadExternal(): unknown;
const parsedJson: unknown = JSON.parse("{}");
const fetchedJson: unknown = loadExternal();

// Type predicates are useful boundary APIs; calls are deliberately ignored.
const isString = (value: unknown): value is string => typeof value === "string";
const knownString = "known";
isString(knownString);

// Explicit closed contracts are useful and do not discard key-space evidence.
const closedValue: { readonly id: string } = { id: "known" };

export {
  unknownValue,
  openCommands,
  narrowedCommands,
  assertedValue,
  createUnknown,
  emptyCommands,
  finiteCommands,
  parsedJson,
  fetchedJson,
  isString,
  closedValue,
};
