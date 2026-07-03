import { APIError } from "better-auth/api";

import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";

const SIGN_UP_EMAIL_PATH = "/sign-up/email";
const BOOTSTRAP_ERROR_MESSAGE = "Self-host bootstrap is not available.";

type BootstrapBody = Record<string, unknown>;

const isBootstrapBody = (body: unknown): body is BootstrapBody =>
  typeof body === "object" && body !== null && !Array.isArray(body);

export const isSelfhostLocalPasswordAuthEnabled = () =>
  env.SELFHOST_LOCAL_PASSWORD_AUTH;

export const hasAnyAuthUsers = async (): Promise<boolean> => {
  const existingUser = await rootDb.query.user.findFirst({
    columns: { id: true },
  });
  return !!existingUser;
};

export const isBootstrapTokenMatch = ({
  candidate,
  expected,
}: {
  candidate: string;
  expected: string;
}) => {
  const candidateHash = new Bun.CryptoHasher("sha256")
    .update(candidate)
    .digest("hex");
  const expectedHash = new Bun.CryptoHasher("sha256")
    .update(expected)
    .digest("hex");
  return candidateHash === expectedHash;
};

export const isSelfhostBootstrapAvailable = async () =>
  isSelfhostLocalPasswordAuthEnabled() &&
  !!env.SELFHOST_BOOTSTRAP_TOKEN &&
  !(await hasAnyAuthUsers());

const readBootstrapToken = (body: unknown): string | null => {
  if (!isBootstrapBody(body)) {
    return null;
  }

  const token = body["bootstrapToken"];
  return typeof token === "string" && token.length > 0 ? token : null;
};

export const assertSelfhostBootstrapSignUp = async (body: unknown) => {
  if (!isSelfhostLocalPasswordAuthEnabled() || !env.SELFHOST_BOOTSTRAP_TOKEN) {
    throw new APIError("BAD_REQUEST", {
      message: BOOTSTRAP_ERROR_MESSAGE,
    });
  }

  if (await hasAnyAuthUsers()) {
    throw new APIError("BAD_REQUEST", {
      message: BOOTSTRAP_ERROR_MESSAGE,
    });
  }

  const bootstrapToken = readBootstrapToken(body);
  if (
    !bootstrapToken ||
    !isBootstrapTokenMatch({
      candidate: bootstrapToken,
      expected: env.SELFHOST_BOOTSTRAP_TOKEN,
    })
  ) {
    throw new APIError("BAD_REQUEST", {
      message: BOOTSTRAP_ERROR_MESSAGE,
    });
  }
};

export const shouldHandleSelfhostBootstrapPath = (path: string) =>
  path === SIGN_UP_EMAIL_PATH;
