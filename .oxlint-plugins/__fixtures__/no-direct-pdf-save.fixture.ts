// Passive regression fixture for `no-direct-pdf-save`.
//
// Each `oxlint-disable-next-line` suppresses a case the rule MUST flag; if the
// rule regresses, the unused directive fails the fixture harness.

import { PDF } from "@libpdf/core";

import { savePdfRewrite } from "@/api/lib/files/pdf-signatures";

declare const bytes: Uint8Array;
declare const unrelated: { save: () => Promise<Uint8Array> };

const loaded = await PDF.load(bytes);

// A loaded document saved directly bypasses the signed-file refusal.
// oxlint-disable-next-line no-direct-pdf-save/no-direct-pdf-save
const _direct = await loaded.save();

// Saving through the owner is the sanctioned path.
// expect-clean: no-direct-pdf-save/no-direct-pdf-save
const _owned = await savePdfRewrite({ pdf: loaded, source: bytes });

// A `save` on something that is not a PDF document is not tracked.
// expect-clean: no-direct-pdf-save/no-direct-pdf-save
const _other = await unrelated.save();

export const __noDirectPdfSaveFixture = { _direct, _other, _owned };
