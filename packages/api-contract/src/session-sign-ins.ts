import * as v from "valibot";

/**
 * Whether a sign-in waits for its account holder to recognise it. A sign-in
 * that triggered the new-device email starts `pending`; the holder confirms
 * it (and may undo that) or signs the device out, which ends the session.
 */
export const SESSION_SIGN_IN_REVIEW = {
  notRequired: "not_required",
  pending: "pending",
  confirmed: "confirmed",
} as const;

export const SESSION_SIGN_IN_REVIEW_STATUSES = [
  SESSION_SIGN_IN_REVIEW.notRequired,
  SESSION_SIGN_IN_REVIEW.pending,
  SESSION_SIGN_IN_REVIEW.confirmed,
] as const;

export type SessionSignInReview =
  (typeof SESSION_SIGN_IN_REVIEW_STATUSES)[number];

/** The statuses the account holder may move a sign-in to. */
export const SESSION_SIGN_IN_REVIEW_DECISIONS = [
  SESSION_SIGN_IN_REVIEW.confirmed,
  SESSION_SIGN_IN_REVIEW.pending,
] as const;

const COUNTRY_CODE = /^[A-Z]{2}$/u;

/**
 * Where a session signed in from, as approximate as IP geolocation is.
 * `unknown` when nothing trustworthy said, and for sessions that began before
 * locations were recorded. Coordinates are rounded to 0.1°.
 */
export const sessionSignInLocationSchema = v.variant("type", [
  v.strictObject({ type: v.literal("unknown") }),
  v.strictObject({
    type: v.literal("known"),
    countryCode: v.pipe(v.string(), v.regex(COUNTRY_CODE)),
    region: v.nullable(v.string()),
    city: v.nullable(v.string()),
    coordinates: v.nullable(
      v.strictObject({ latitude: v.number(), longitude: v.number() }),
    ),
  }),
]);

export type SessionSignInLocation = v.InferOutput<
  typeof sessionSignInLocationSchema
>;

export const sessionSignInsSchema = v.strictObject({
  sessions: v.array(
    v.strictObject({
      id: v.string(),
      location: sessionSignInLocationSchema,
      review: v.picklist(SESSION_SIGN_IN_REVIEW_STATUSES),
    }),
  ),
});

export const sessionSignInReviewBodySchema = v.strictObject({
  sessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  review: v.picklist(SESSION_SIGN_IN_REVIEW_DECISIONS),
});

export const sessionSignInReviewResultSchema = v.strictObject({
  review: v.picklist(SESSION_SIGN_IN_REVIEW_STATUSES),
});

export const SESSION_SIGN_INS_PATH = "/session-sign-ins";
export const SESSION_SIGN_IN_REVIEW_PATH = "/session-sign-ins/review";
export const SESSION_SIGN_IN_MAP_PATH = "/session-sign-ins/map";
