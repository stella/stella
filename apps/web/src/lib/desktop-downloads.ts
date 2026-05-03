import { env } from "@/env";

const BASE = env.VITE_DESKTOP_RELEASES_BASE_URL.replace(/\/$/u, "");

export const MACOS_DMG_URL = `${BASE}/Stella-macos-universal.dmg`;
export const WINDOWS_EXE_URL = `${BASE}/Stella-windows-x64-setup.exe`;
export const WINDOWS_MSI_URL = `${BASE}/Stella-windows-x64.msi`;

export type DesktopPlatform = "mac" | "windows" | "other";

const MOBILE_UA =
  /android|iphone|ipad|ipod|webos|blackberry|iemobile|opera mini/u;

export const detectDesktopPlatform = (): DesktopPlatform => {
  if (typeof navigator === "undefined") {
    return "other";
  }
  const ua = navigator.userAgent.toLowerCase();
  // iOS Safari reports "Mac OS X" in its UA, and iPadOS in
  // desktop-site mode reports as "Macintosh" with no iPad token.
  // Filter both before matching desktop platforms; touch-capable
  // "Macs" are actually iPads (real Macs report maxTouchPoints 0).
  const isIPadInDesktopMode =
    ua.includes("macintosh") && navigator.maxTouchPoints > 1;
  if (MOBILE_UA.test(ua) || isIPadInDesktopMode) {
    return "other";
  }
  if (ua.includes("mac")) {
    return "mac";
  }
  if (ua.includes("win")) {
    return "windows";
  }
  return "other";
};
