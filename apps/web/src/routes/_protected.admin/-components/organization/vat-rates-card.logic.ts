import type { VatRateCommand } from "@/lib/organization/vat-rates";

export type VatPresetResult = { added: number; skipped: number } | null;

export const presetResultWhenCommandStarts = (
  command: VatRateCommand,
  current: VatPresetResult,
): VatPresetResult => (command.type === "applyPreset" ? null : current);
