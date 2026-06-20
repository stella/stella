import type { ParagraphAttrs } from "./schema/nodes";

type AutospacingBase = NonNullable<ParagraphAttrs["_autospacingBase"]>;
type AutospacingSide = "before" | "after";

export function normalizeAutospacingBaseValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function setAutospacingBaseValue(
  base: AutospacingBase,
  side: AutospacingSide,
  value: unknown,
): void {
  base[side] = normalizeAutospacingBaseValue(value);
}

export function hasAutospacingBaseSide(
  base: ParagraphAttrs["_autospacingBase"] | null | undefined,
  side: AutospacingSide,
): boolean {
  return base !== undefined && base !== null && Object.hasOwn(base, side);
}

export function autospacingMatchesBase(
  base: ParagraphAttrs["_autospacingBase"] | null | undefined,
  side: AutospacingSide,
  currentValue: unknown,
): boolean {
  if (!hasAutospacingBaseSide(base, side)) {
    return false;
  }

  return normalizeAutospacingBaseValue(currentValue) === (base?.[side] ?? null);
}
