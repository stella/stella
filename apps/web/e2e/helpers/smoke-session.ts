import { panic } from "better-result";
import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.nonEmpty());

const smokeSessionSchema = v.object({
  cookieName: nonEmpty,
  cookieValue: nonEmpty,
  expiresAt: v.pipe(
    v.string(),
    v.check((value) => !Number.isNaN(Date.parse(value))),
  ),
});

type SmokeSessionStorageStateOptions = {
  headers: Record<string, string>;
  secret: string;
  sessionUrl: string;
  webUrl: string;
};

export const fetchSmokeSessionStorageState = async ({
  headers,
  secret,
  sessionUrl,
  webUrl,
}: SmokeSessionStorageStateOptions) => {
  const response = await fetch(sessionUrl, {
    method: "POST",
    headers: { "x-smoke-secret": secret, ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${new URL(sessionUrl).pathname} -> ${String(response.status)}`,
    );
  }
  const session = v.safeParse(smokeSessionSchema, await response.json());
  if (!session.success) {
    return panic("The smoke session response has an unexpected shape");
  }
  const { cookieName, cookieValue, expiresAt } = session.output;
  return {
    cookies: [
      {
        name: cookieName,
        value: cookieValue,
        domain: new URL(webUrl).hostname,
        path: "/",
        expires: Math.floor(Date.parse(expiresAt) / 1000),
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
};
