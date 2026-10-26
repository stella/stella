import { panic } from "better-result";
import * as v from "valibot";

export const EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH =
  "scripts/external-contract-pin-allowances.json";

const nonempty = v.pipe(v.string(), v.trim(), v.minLength(1));
const allowanceSchema = v.strictObject({
  id: nonempty,
  system: nonempty,
  pins: v.record(nonempty, nonempty),
  checkedAt: v.string(),
  expiresAt: v.string(),
  reason: nonempty,
});
const ledgerSchema = v.strictObject({ allowances: v.array(allowanceSchema) });
export type ExternalContractPinAllowance = v.InferOutput<
  typeof allowanceSchema
>;
const MAX_ALLOWANCE_MS = 7 * 86_400_000;

const utcInstant = (value: string): number => {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) {
    panic(
      `External contract pin allowance requires a canonical UTC timestamp: ${value}`,
    );
  }
  return instant;
};

export const readExternalContractPinAllowances = (
  text: string,
): ExternalContractPinAllowance[] => {
  const { allowances } = v.parse(ledgerSchema, JSON.parse(text));
  const ids = new Set<string>();
  const systems = new Set<string>();
  for (const allowance of allowances) {
    if (ids.has(allowance.id) || systems.has(allowance.system)) {
      panic(`Duplicate external contract pin allowance: ${allowance.id}`);
    }
    ids.add(allowance.id);
    systems.add(allowance.system);
    if (Object.keys(allowance.pins).length === 0) {
      panic(`External contract pin allowance has no pins: ${allowance.id}`);
    }
    const interval =
      utcInstant(allowance.expiresAt) - utcInstant(allowance.checkedAt);
    if (interval <= 0 || interval > MAX_ALLOWANCE_MS) {
      panic(
        `External contract pin allowance must expire within seven days: ${allowance.id}`,
      );
    }
  }
  return allowances;
};
