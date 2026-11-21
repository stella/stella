import { panic } from "better-result";
import * as v from "valibot";

export const JOURNEY_SIGN_IN = {
  seeded: "seeded",
  smokeSession: "smoke-session",
  reviewAccount: "review-account",
} as const;

export type JourneySignIn =
  | { type: typeof JOURNEY_SIGN_IN.seeded }
  | {
      type: typeof JOURNEY_SIGN_IN.smokeSession;
      secret: string;
      sessionUrl: string;
    }
  | {
      type: typeof JOURNEY_SIGN_IN.reviewAccount;
      email: string;
      password: string;
    };

const nonEmpty = v.pipe(v.string(), v.nonEmpty());

const signInSchema = v.variant("JOURNEY_SIGN_IN", [
  v.object({ JOURNEY_SIGN_IN: v.literal(JOURNEY_SIGN_IN.seeded) }),
  v.object({
    JOURNEY_SIGN_IN: v.literal(JOURNEY_SIGN_IN.smokeSession),
    JOURNEY_SMOKE_SESSION_URL: v.pipe(v.string(), v.url()),
    SMOKE_SESSION_SECRET: nonEmpty,
  }),
  v.object({
    JOURNEY_SIGN_IN: v.literal(JOURNEY_SIGN_IN.reviewAccount),
    APP_REVIEW_ACCOUNT_EMAIL: v.pipe(v.string(), v.email()),
    REVIEW_ACCOUNT_PASSWORD: nonEmpty,
  }),
]);

export const readJourneySignIn = (): JourneySignIn => {
  const parsed = v.safeParse(signInSchema, process.env);
  if (!parsed.success) {
    const fields = Object.keys(v.flatten(parsed.issues).nested ?? {});
    return panic(
      `Journey sign-in is not configured; check ${fields.join(", ") || "JOURNEY_SIGN_IN"}`,
    );
  }
  const { output } = parsed;
  switch (output.JOURNEY_SIGN_IN) {
    case JOURNEY_SIGN_IN.seeded:
      return { type: JOURNEY_SIGN_IN.seeded };
    case JOURNEY_SIGN_IN.smokeSession:
      return {
        type: JOURNEY_SIGN_IN.smokeSession,
        secret: output.SMOKE_SESSION_SECRET,
        sessionUrl: output.JOURNEY_SMOKE_SESSION_URL,
      };
    case JOURNEY_SIGN_IN.reviewAccount:
      return {
        type: JOURNEY_SIGN_IN.reviewAccount,
        email: output.APP_REVIEW_ACCOUNT_EMAIL,
        password: output.REVIEW_ACCOUNT_PASSWORD,
      };
    default:
      output satisfies never;
      return panic("Unhandled journey sign-in");
  }
};

export const readJourneyWebUrl = (): string =>
  process.env["E2E_WEB_URL"] ?? "http://localhost:3000";

export const readJourneyEdgeHeaders = (): Record<string, string> => {
  const name = process.env["E2E_EDGE_HEADER_NAME"] ?? "";
  const value = process.env["E2E_EDGE_HEADER_VALUE"] ?? "";
  return name && value ? { [name]: value } : {};
};
