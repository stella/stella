import { panic } from "better-result";

type ContractDomainLedgerEntry = { id: string; reason: string };
const isEntry = (entry: unknown): entry is ContractDomainLedgerEntry =>
  typeof entry === "object" &&
  entry !== null &&
  "id" in entry &&
  typeof entry.id === "string" &&
  "reason" in entry &&
  typeof entry.reason === "string" &&
  entry.reason.trim().length > 0;

export const parseContractDomainLedger = (
  text: string,
  label: string,
): ContractDomainLedgerEntry[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(isEntry)) {
    return panic(`${label} must be a reasoned ledger`);
  }
  for (const [index, entry] of parsed.entries()) {
    if (
      !/^apps\/(?:web\/src|api\/src\/mcp)\/[^:]+::[^:]+::(?:domain|maxLength|minLength|maxSize|maxValue|minValue|max):.+::[1-9]\d*$/u.test(
        entry.id,
      )
    ) {
      panic(`${label} has an invalid site key`);
    }
    const previous = parsed.at(index - 1);
    if (index > 0 && previous !== undefined && previous.id >= entry.id) {
      panic(`${label} must be sorted and duplicate-free`);
    }
  }
  return parsed;
};

export const serializeContractDomainLedger = (
  entries: readonly ContractDomainLedgerEntry[],
): string =>
  `${JSON.stringify(
    entries.toSorted((left, right) => {
      if (left.id < right.id) {
        return -1;
      }
      if (left.id > right.id) {
        return 1;
      }
      return 0;
    }),
    null,
    2,
  )}\n`;
