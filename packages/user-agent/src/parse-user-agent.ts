export type ParsedUserAgent = {
  browser: string | null;
  os: string | null;
};

const BROWSERS = [
  // iOS browsers all run WebKit and also carry `Safari/`; only their own
  // token (EdgiOS, OPT, CriOS, FxiOS) names them.
  [/Edg(?:e|A|iOS)?\//u, "Edge"],
  [/OPR\/|OPT\/|Opera\//u, "Opera"],
  [/Vivaldi\//u, "Vivaldi"],
  [/CriOS\//u, "Chrome"],
  [/FxiOS\//u, "Firefox"],
  [/Firefox\//u, "Firefox"],
  [/Chrome\//u, "Chrome"],
  [/Safari\//u, "Safari"],
] as const satisfies readonly (readonly [RegExp, string])[];

const OPERATING_SYSTEMS = [
  [/Windows/u, "Windows"],
  [/iPhone|iPad|iPod/u, "iOS"],
  [/Android/u, "Android"],
  [/Mac OS X|macOS/u, "macOS"],
  [/CrOS/u, "ChromeOS"],
  [/Linux/u, "Linux"],
] as const satisfies readonly (readonly [RegExp, string])[];

export const parseUserAgent = (
  ua: string | null | undefined,
): ParsedUserAgent => {
  if (!ua) {
    return { browser: null, os: null };
  }

  let browser: string | null = null;
  for (const [pattern, name] of BROWSERS) {
    if (pattern.test(ua)) {
      browser = name;
      break;
    }
  }

  let os: string | null = null;
  for (const [pattern, name] of OPERATING_SYSTEMS) {
    if (pattern.test(ua)) {
      os = name;
      break;
    }
  }

  return { browser, os };
};
