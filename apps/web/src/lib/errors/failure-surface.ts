/**
 * Where one failed mutation tells the person. A form that renders the failure
 * beside its field declares `inline` in the mutation's `meta`; the toast the
 * shared notifier would raise for that same failure then stays out, whichever
 * handler asked for it.
 */
export const FAILURE_SURFACE = { inline: "inline", toast: "toast" } as const;

export type FailureSurface =
  (typeof FAILURE_SURFACE)[keyof typeof FAILURE_SURFACE];

const shownInline = new WeakSet<object>();

/** Called by the mutation cache, which runs before any hook's `onError`. */
export const recordFailureSurface = (
  error: unknown,
  surface: FailureSurface | undefined,
): void => {
  if (
    surface === FAILURE_SURFACE.inline &&
    typeof error === "object" &&
    error !== null
  ) {
    shownInline.add(error);
  }
};

export const isShownInline = (error: unknown): boolean =>
  typeof error === "object" && error !== null && shownInline.has(error);
