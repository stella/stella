// Passive regression fixture for
// `no-optional-mutation-command/no-optional-mutation-command`.

import { useMutation } from "@tanstack/react-query";

import type { NonEmptyPatch } from "@/lib/mutation-command";

const save = async (_value: unknown) => {
  await Promise.resolve();
};

type OptionalUpdateBag = {
  color?: string;
  name?: string;
};

type ExplicitUpdate =
  | { type: "color"; value: string }
  | { type: "name"; value: string };

export const useInlineOptionalBag = () =>
  useMutation({
    // oxlint-disable-next-line no-optional-mutation-command/no-optional-mutation-command -- fixture proves inline optional command bags are rejected
    mutationFn: async (body: { color?: string; name?: string }) => save(body),
  });

export const useNamedOptionalBag = () =>
  useMutation({
    // oxlint-disable-next-line no-optional-mutation-command/no-optional-mutation-command -- fixture proves named optional command bags are rejected
    mutationFn: async (body: OptionalUpdateBag) => save(body),
  });

export const useLaterDeclaredOptionalBag = () =>
  useMutation({
    // oxlint-disable-next-line no-optional-mutation-command/no-optional-mutation-command -- fixture proves declaration order cannot evade the rule
    mutationFn: async (body: LaterDeclaredOptionalBag) => save(body),
  });

type LaterDeclaredOptionalBag = {
  color?: string;
  name?: string;
};

export const useExplicitCommand = () =>
  useMutation({
    mutationFn: async (update: ExplicitUpdate) => save(update),
  });

export const useIntentionalBatchPatch = () =>
  useMutation({
    mutationFn: async (
      patch: NonEmptyPatch<{ color: string; name: string }>,
    ) => save(patch),
  });
