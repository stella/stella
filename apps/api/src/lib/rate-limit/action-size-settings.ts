import { panic } from "better-result";

/** The operator limits behind the tenant action size policy. */
export type ActionSizeLimitSettings = {
  readonly ACTION_REQUEST_MAX_BYTES?: number | undefined;
  readonly ACTION_RESPONSE_MAX_BYTES?: number | undefined;
  readonly ACTION_PAGE_SIZE_MAX?: number | undefined;
};

let limitsReader: (() => ActionSizeLimitSettings) | null = null;

/**
 * The limits belong to the API environment, which a process that only reads
 * the public corpus never loads. The API environment binds its reader here
 * once, so the size policy reads them per call without importing it.
 */
export const bindActionSizeLimitsReader = (
  reader: () => ActionSizeLimitSettings,
): void => {
  if (limitsReader !== null) {
    panic("Action size limits are bound once");
  }
  limitsReader = reader;
};

const UNBOUND: ActionSizeLimitSettings = {
  ACTION_REQUEST_MAX_BYTES: undefined,
  ACTION_RESPONSE_MAX_BYTES: undefined,
  ACTION_PAGE_SIZE_MAX: undefined,
};

/**
 * The configured limits. Without the API environment none is set; its
 * admission flag then reads off as well, and an enabled policy without limits
 * fails closed.
 */
export const readActionSizeLimits = (): ActionSizeLimitSettings =>
  limitsReader?.() ?? UNBOUND;
