import { transition } from "@/api/lib/db/transitions";

declare const tx: Parameters<typeof transition>[0];
declare const spec: Parameters<typeof transition>[1];
declare const id: string;
declare const options: Parameters<typeof transition>[3];

// oxlint-disable-next-line no-discarded-transition-result/no-discarded-transition-result -- fixture proves a stale result cannot be discarded
await transition(tx, spec, id, options);
// expect-clean: no-discarded-transition-result/no-discarded-transition-result
export const result = await transition(tx, spec, id, options);
