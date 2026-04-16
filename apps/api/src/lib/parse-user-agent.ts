type ParsedUserAgent = {
  browser: string | null;
  os: string | null;
};

const BROWSERS = [
  [/Edg(?:e|A)?\//, "Edge"],
  [/OPR\/|Opera\//, "Opera"],
  [/Vivaldi\//, "Vivaldi"],
  [/CriOS\//, "Chrome"],
  [/FxiOS\//, "Firefox"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
] as const satisfies readonly (readonly [RegExp, string])[];

const OPERATING_SYSTEMS = [
  [/Windows/, "Windows"],
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X|macOS/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
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
