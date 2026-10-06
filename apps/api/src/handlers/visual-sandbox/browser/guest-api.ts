import * as v from "valibot";

import {
  visualGuestMessageSchema,
  type VisualGuestMessage,
} from "@stll/api-contract/visual-sandbox";

const frozenVisualData = (data: unknown) => {
  const copy: unknown = structuredClone(data);
  const pending: unknown[] = [copy];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) {
      continue;
    }
    for (const child of Object.values(value)) {
      pending.push(child);
    }
    Object.freeze(value);
  }
  return copy;
};

type CreateVisualGuestApiOptions = {
  data: unknown;
  postMessage: (message: VisualGuestMessage) => void;
  measureSize: () => { width: number; height: number };
};

export const createVisualGuestApi = ({
  data,
  postMessage,
  measureSize,
}: CreateVisualGuestApiOptions) => {
  const emit = (message: VisualGuestMessage) => {
    const validated = v.safeParse(visualGuestMessageSchema, message);
    if (validated.success) {
      postMessage(validated.output);
    }
  };
  return Object.freeze({
    data: frozenVisualData(data),
    drill: ({ court, year }: { court: string; year: number }) =>
      emit({ kind: "drill", court, year }),
    openDecision: (linkId: string) => emit({ kind: "open-internal", linkId }),
    ready: () => emit({ kind: "ready", size: measureSize() }),
  });
};
