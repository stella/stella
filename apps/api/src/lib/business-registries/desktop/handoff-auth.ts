import type { InferOk } from "better-result";
import { Result } from "better-result";

import {
  DESKTOP_HANDOFF_FAILURE,
  DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL,
  DESKTOP_HANDOFF_PROTOCOL_HEADER,
} from "@stll/api-contract/desktop-handoff";

import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { recordDesktopHandoffFailure } from "@/api/lib/desktop-edit-handoffs";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export type DesktopHandoffAuthorizationDependencies = {
  authorizeAccount: typeof authorizeDesktopAccount;
  recordFailure: typeof recordDesktopHandoffFailure;
};

type AuthorizeDesktopHandoffOptions = {
  request: Request;
  handoffToken: unknown;
  kind: "desktop_edit" | "pdf_signing";
};

type DesktopHandoffAuthorizationResult = Result<
  InferOk<Awaited<ReturnType<typeof authorizeDesktopAccount>>>,
  HandlerError<401 | 426 | 503>
>;

const DEFAULT_DEPENDENCIES = {
  authorizeAccount: authorizeDesktopAccount,
  recordFailure: recordDesktopHandoffFailure,
};

export const authorizeDesktopHandoff = async (
  { request, handoffToken, kind }: AuthorizeDesktopHandoffOptions,
  {
    authorizeAccount,
    recordFailure,
  }: DesktopHandoffAuthorizationDependencies = DEFAULT_DEPENDENCIES,
): Promise<DesktopHandoffAuthorizationResult> => {
  const protocol = request.headers.get(DESKTOP_HANDOFF_PROTOCOL_HEADER);
  const version =
    protocol !== null && /^[1-9]\d*$/u.test(protocol)
      ? Number(protocol)
      : Number.NaN;
  const authorization =
    !Number.isSafeInteger(version) ||
    version < DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL
      ? Result.err(
          new HandlerError({
            status: 426,
            code: DESKTOP_HANDOFF_FAILURE.updateRequired,
            message: "Update stella desktop",
            retryable: false,
          }),
        )
      : await authorizeAccount(request);

  if (authorization.isOk()) {
    return authorization;
  }
  if (
    authorization.error.status !== 401 &&
    authorization.error.status !== 426
  ) {
    return authorization;
  }
  const reason =
    authorization.error.status === 426
      ? DESKTOP_HANDOFF_FAILURE.updateRequired
      : DESKTOP_HANDOFF_FAILURE.accountRequired;
  const error = new HandlerError({
    status: authorization.error.status,
    code: reason,
    message: authorization.error.message,
    retryable: false,
  });
  if (typeof handoffToken !== "string") {
    return Result.err(error);
  }
  const recorded = await Result.tryPromise({
    try: async () => await recordFailure({ kind, handoffToken, reason }),
    catch: (cause) =>
      new HandlerError({
        status: 503,
        message: "Handoff status is unavailable. Try again shortly.",
        retryable: true,
        cause,
      }),
  });
  if (recorded.isErr()) {
    return recorded;
  }
  return Result.err(error);
};
