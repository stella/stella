import { normalizeRedirectTo } from "@/lib/redirect";

/** Remove handoff parameters from URLs before preserving URL metadata. */
export const sanitizeHandoffUrl = (value: string): string => {
  if (!URL.canParse(value)) {
    return value;
  }
  const url = new URL(value);
  url.searchParams.delete("sh");
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (fragment.has("sh")) {
    url.hash = url.hash
      .slice(1)
      .split("&")
      .filter((part) => !new URLSearchParams(part).has("sh"))
      .join("&");
  }
  return url.href;
};

export const handoffNavigationDestination = (
  destination: string,
  status: "redeemed" | "refused",
) => {
  const clean = normalizeRedirectTo(destination);
  if (status === "redeemed" || /^\/law(?:\/|[?#]|$)/iu.test(clean)) {
    return clean;
  }
  return `/auth?redirectTo=${encodeURIComponent(clean)}`;
};
