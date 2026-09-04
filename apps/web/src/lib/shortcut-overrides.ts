import { hasNonModifierKey, normalizeHotkey } from "@tanstack/react-hotkeys";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { panic, Result } from "better-result";

import { SHORTCUT_GROUPS } from "@/lib/hotkeys";
import type {
  ShortcutBinding,
  ShortcutContext,
  ShortcutGroup,
  ShortcutId,
  ShortcutLabelKey,
} from "@/lib/hotkeys";

/**
 * Per-user rebindings, keyed by {@link ShortcutId}. An entry overrides that
 * shortcut's default binding; a missing entry means "use the default", so a
 * reset is modeled by removing the key rather than storing a sentinel. Only
 * hotkey-chord shortcuts are rebindable (see {@link REBINDABLE_SHORTCUT_IDS}),
 * so override values are always hotkey bindings.
 */
export type ShortcutOverrides = Partial<
  Record<ShortcutId, { readonly type: "hotkey"; readonly hotkey: Hotkey }>
>;

const flattenShortcuts = (groups: readonly ShortcutGroup[]) =>
  groups.flatMap((group) => group.shortcuts);

/**
 * The ids that can be rebound: only those whose default binding is a hotkey
 * chord. `char` bindings (e.g. `?`) are layout characters, not chords, so they
 * are read-only and can never appear in an override map.
 */
export const REBINDABLE_SHORTCUT_IDS: readonly ShortcutId[] = Object.freeze(
  flattenShortcuts(SHORTCUT_GROUPS).flatMap((shortcut) =>
    shortcut.binding.type === "hotkey" ? [shortcut.id] : [],
  ),
);

export const isRebindableShortcut = (id: ShortcutId): boolean =>
  REBINDABLE_SHORTCUT_IDS.includes(id);

const isShortcutId = (value: string): value is ShortcutId =>
  flattenShortcuts(SHORTCUT_GROUPS).some((shortcut) => shortcut.id === value);

/**
 * Parse the stored `userShortcuts` JSON into an override map. Best-effort by
 * design: unknown ids, non-rebindable ids, and malformed hotkeys are dropped
 * rather than thrown, so a client on an older shortcut vocabulary degrades to
 * defaults instead of breaking. The server applies the authoritative structural
 * cap; this is the read side.
 */
export const parseUserShortcuts = (
  raw: string | null | undefined,
): ShortcutOverrides => {
  if (!raw) {
    return {};
  }

  const parsed = Result.try((): unknown => JSON.parse(raw));
  if (Result.isError(parsed) || typeof parsed.value !== "object") {
    return {};
  }
  const record = parsed.value;
  if (record === null || Array.isArray(record)) {
    return {};
  }

  const overrides: ShortcutOverrides = {};
  for (const [id, value] of Object.entries(record)) {
    if (typeof value !== "string" || !isShortcutId(id)) {
      continue;
    }
    if (!isRebindableShortcut(id)) {
      continue;
    }
    const hotkey = normalizeHotkey(value);
    if (!hasNonModifierKey(hotkey)) {
      continue;
    }
    overrides[id] = { type: "hotkey", hotkey };
  }
  return overrides;
};

export const serializeUserShortcuts = (
  overrides: ShortcutOverrides,
): string => {
  const record: Record<string, string> = {};
  for (const [id, binding] of Object.entries(overrides)) {
    record[id] = binding.hotkey;
  }
  return JSON.stringify(record);
};

/**
 * Apply an override map onto the default registry, returning a fresh group
 * list. Every surface (dialog, overlay, echo matcher, real `useHotkey`
 * registrations) reads from this so a rebind actually changes behavior.
 */
export const applyOverridesToGroups = (
  groups: readonly ShortcutGroup[],
  overrides: ShortcutOverrides,
): ShortcutGroup[] =>
  groups.map((group) => ({
    categoryKey: group.categoryKey,
    shortcuts: group.shortcuts.map((shortcut) => {
      const override = overrides[shortcut.id];
      if (!override) {
        return shortcut;
      }
      // Explicit branch construction: a rebind only ever swaps the binding of a
      // hotkey shortcut, so preserve id/labelKey/contexts and replace binding.
      return {
        id: shortcut.id,
        binding: override,
        labelKey: shortcut.labelKey,
        contexts: shortcut.contexts,
      };
    }),
  }));

/** Canonical identity for a binding; two bindings collide iff these are equal. */
export const bindingKey = (binding: ShortcutBinding): string => {
  switch (binding.type) {
    case "hotkey":
      return `hotkey:${binding.hotkey}`;
    case "char":
      return `char:${binding.char}`;
    default: {
      binding satisfies never;
      return panic(`Unhandled binding: ${String(binding)}`);
    }
  }
};

type CollisionCandidate = {
  readonly id: ShortcutId;
  readonly binding: ShortcutBinding;
  readonly labelKey: ShortcutLabelKey;
  readonly contexts: readonly ShortcutContext[];
};

export type ShortcutCollision = {
  readonly context: ShortcutContext;
  readonly bindingKey: string;
  readonly ids: readonly ShortcutId[];
};

const isActiveInContext = (
  contexts: readonly ShortcutContext[],
  context: ShortcutContext,
): boolean => contexts.some((c) => c === context || c === "global");

/**
 * The shared collision checker: the same key combo bound to two shortcuts that
 * are both live inside one {@link ShortcutContext} (directly, or via a `global`
 * shortcut active everywhere) is a collision. Used by BOTH the registry test
 * and the runtime rebind save-guard so the invariant has exactly one
 * implementation.
 */
export const findContextCollisions = (
  candidates: readonly CollisionCandidate[],
  contexts: readonly ShortcutContext[],
): ShortcutCollision[] => {
  const collisions: ShortcutCollision[] = [];
  for (const context of contexts) {
    const active = candidates.filter((candidate) =>
      isActiveInContext(candidate.contexts, context),
    );
    const idsByBinding = new Map<string, ShortcutId[]>();
    for (const candidate of active) {
      const key = bindingKey(candidate.binding);
      const ids = idsByBinding.get(key);
      if (ids) {
        ids.push(candidate.id);
        continue;
      }
      idsByBinding.set(key, [candidate.id]);
    }
    for (const [key, ids] of idsByBinding) {
      if (ids.length > 1) {
        collisions.push({ context, bindingKey: key, ids });
      }
    }
  }
  return collisions;
};

export const collectShortcutCandidates = (
  groups: readonly ShortcutGroup[],
): CollisionCandidate[] =>
  flattenShortcuts(groups).map((shortcut) => ({
    id: shortcut.id,
    binding: shortcut.binding,
    labelKey: shortcut.labelKey,
    contexts: shortcut.contexts,
  }));

/**
 * A rejected rebind, surfaced to the user. `collision` carries the label of the
 * shortcut already using that combo so the message can name it.
 */
export type RebindError =
  | { readonly type: "notRebindable" }
  | { readonly type: "invalidBinding" }
  | { readonly type: "collision"; readonly conflictLabelKey: ShortcutLabelKey };

type ValidateRebindInput = {
  readonly id: ShortcutId;
  // The raw recorded candidate: it may not yet be a valid `Hotkey` (e.g. a
  // modifier-only chord), which is exactly what the guard below rejects.
  readonly hotkey: string;
  readonly groups: readonly ShortcutGroup[];
  readonly overrides: ShortcutOverrides;
};

/**
 * Validate a proposed rebind against the effective registry. On success returns
 * the next override map (ready to serialize + persist); on failure a typed
 * {@link RebindError} the UI renders. The rebind is rejected when it would make
 * the target shortcut collide with another shortcut live in a shared context.
 */
export const validateRebind = ({
  id,
  hotkey,
  groups,
  overrides,
}: ValidateRebindInput): Result<ShortcutOverrides, RebindError> => {
  if (!isRebindableShortcut(id)) {
    return Result.err({ type: "notRebindable" });
  }
  const normalized = normalizeHotkey(hotkey);
  if (!hasNonModifierKey(normalized)) {
    return Result.err({ type: "invalidBinding" });
  }

  const nextOverrides: ShortcutOverrides = {
    ...overrides,
    [id]: { type: "hotkey", hotkey: normalized },
  };
  const candidates = collectShortcutCandidates(
    applyOverridesToGroups(groups, nextOverrides),
  );
  const target = candidates.find((candidate) => candidate.id === id);
  if (!target) {
    return Result.err({ type: "notRebindable" });
  }

  const collisions = findContextCollisions(candidates, target.contexts);
  const conflict = collisions.find((collision) => collision.ids.includes(id));
  if (conflict) {
    const conflictId = conflict.ids.find((other) => other !== id);
    const conflictLabelKey = candidates.find(
      (candidate) => candidate.id === conflictId,
    )?.labelKey;
    return Result.err({
      type: "collision",
      conflictLabelKey: conflictLabelKey ?? target.labelKey,
    });
  }

  return Result.ok(nextOverrides);
};

/** Remove a shortcut's override, returning it to its default binding. */
export const resetShortcutOverride = (
  overrides: ShortcutOverrides,
  id: ShortcutId,
): ShortcutOverrides => {
  const next: ShortcutOverrides = {};
  for (const key of REBINDABLE_SHORTCUT_IDS) {
    const binding = overrides[key];
    if (key !== id && binding) {
      next[key] = binding;
    }
  }
  return next;
};
