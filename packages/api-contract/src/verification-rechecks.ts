/**
 * Claims one bulk re-check request grades: three of the grader's batches of
 * ten, which it runs at once, so a request waits for one round of model
 * calls. The API refuses more and the web sends its out-of-date claims in
 * requests of this size.
 */
export const VERIFICATION_RECHECKS_PER_REQUEST_MAX = 30;
