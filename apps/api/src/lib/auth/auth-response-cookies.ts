import type { Context } from "elysia";

export const forwardAuthResponseCookies = (
  target: Context["set"]["headers"],
  source: Headers,
) => {
  const cookies = source.getSetCookie();
  if (cookies.length === 0) {
    return;
  }
  const existing = target["set-cookie"];
  const combined: string[] = [];
  if (Array.isArray(existing)) {
    combined.push(...existing);
  } else if (existing) {
    combined.push(existing);
  }
  combined.push(...cookies);
  target["set-cookie"] = combined;
};
