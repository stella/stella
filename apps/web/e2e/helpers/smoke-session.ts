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
  /** Origin the tests' request fixture calls directly. */
  apiUrl: string;
  headers: Record<string, string>;
  secret: string;
  sessionUrl: string;
  /** Origin the browser loads. */
  webUrl: string;
};

/**
 * The smoke session as Playwright storage state. Cookies are host-only, and a
 * deployed web app and its API live on different hosts, so the session is
 * stored for both: the browser sends it to the web host, the request fixture
 * to the API host.
 */
export const fetchSmokeSessionStorageState = async ({
  apiUrl,
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
  const hosts = new Set([new URL(webUrl).hostname, new URL(apiUrl).hostname]);
  return {
    cookies: [...hosts].map((domain) => ({
      name: cookieName,
      value: cookieValue,
      domain,
      path: "/",
      expires: Math.floor(Date.parse(expiresAt) / 1000),
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    })),
    origins: [],
  };
};
