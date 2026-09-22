import { useBlocker } from "@tanstack/react-router";
import type { ShouldBlockFn } from "@tanstack/react-router";
import { panic } from "better-result";

import { useExternalSyncEffect } from "@/hooks/use-effect";

// The single owner of "local work a reload or navigation would lose".
// Editors report dirtiness through `useUnsavedWork`; route blocking and the
// `beforeunload` prompt both go through TanStack's history blocker here, and
// the stale-client refresh reads `hasUnsavedWork()` before reloading. The
// `no-direct-unsaved-work-guard` lint rule keeps other modules from
// installing their own blocker or unload listener.

type UnsavedWorkSurface =
  | "chat-draft"
  | "docx-edit-session"
  | "document-docx-editor"
  | "pdf-page-organizer"
  | "playbook-editor"
  | "template-studio";

const registrations = new Set<symbol>();

const registerUnsavedWork = (surface: UnsavedWorkSurface): (() => void) => {
  const registration = Symbol(surface);
  registrations.add(registration);
  return () => {
    registrations.delete(registration);
  };
};

export const hasUnsavedWork = (): boolean => registrations.size > 0;

type UnsavedWorkGuard =
  // Only defers the silent stale-client reload; no prompt, no route block.
  | { guard: "silent-reload" }
  // Prompts on tab close or hard navigation; in-app navigation proceeds.
  | { guard: "unload" }
  // Blocks in-app navigation until the caller's dialog calls
  // `proceed` or `reset`. `shouldBlockNavigation` is read at navigation
  // time, for state a caller flips just before navigating away itself.
  | { guard: "confirm-navigation"; shouldBlockNavigation?: () => boolean }
  // Blocks in-app navigation when `shouldBlockNavigation` resolves true;
  // the caller settles the work itself, with no resolver dialog.
  | { guard: "decide-navigation"; shouldBlockNavigation: ShouldBlockFn };

type UseUnsavedWorkOptions = UnsavedWorkGuard & {
  surface: UnsavedWorkSurface;
  isDirty: boolean;
};

type UnsavedWorkBlocker =
  | { status: "idle" }
  | { status: "blocked"; proceed: () => void; reset: () => void };

const IDLE_BLOCKER: UnsavedWorkBlocker = { status: "idle" };

const shouldBlockFor = (options: UseUnsavedWorkOptions): ShouldBlockFn => {
  switch (options.guard) {
    case "silent-reload":
    case "unload":
      return () => false;
    case "confirm-navigation": {
      const { shouldBlockNavigation } = options;
      return () => shouldBlockNavigation?.() ?? true;
    }
    case "decide-navigation":
      return options.shouldBlockNavigation;
    default:
      options satisfies never;
      return panic(`Unhandled unsaved-work guard: ${String(options)}`);
  }
};

export const useUnsavedWork = (
  options: UseUnsavedWorkOptions,
): UnsavedWorkBlocker => {
  const { surface, isDirty, guard } = options;

  useExternalSyncEffect(() => {
    if (!isDirty) {
      return undefined;
    }
    return registerUnsavedWork(surface);
  }, [isDirty, surface]);

  const guardsUnload = isDirty && guard !== "silent-reload";
  const blocker = useBlocker({
    shouldBlockFn: shouldBlockFor(options),
    enableBeforeUnload: guardsUnload,
    disabled: !guardsUnload,
    withResolver: guard === "confirm-navigation",
  });

  // TanStack returns an idle resolver whenever `withResolver` is off; the
  // `void` in its signature only reflects the non-literal flag.
  if (blocker === undefined || blocker.status === "idle") {
    return IDLE_BLOCKER;
  }
  return {
    status: "blocked",
    proceed: blocker.proceed,
    reset: blocker.reset,
  };
};
