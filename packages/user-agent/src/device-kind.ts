/**
 * What kind of device a user agent belongs to, as far as the string tells.
 * A laptop and a desktop computer send the same user agent, so both are a
 * `computer`; an iPad that asks for desktop sites reports itself as a Mac and
 * reads as one.
 */
export const DEVICE_KIND = {
  phone: "phone",
  tablet: "tablet",
  computer: "computer",
  desktopApp: "desktopApp",
  unknown: "unknown",
} as const;

export type DeviceKind = (typeof DEVICE_KIND)[keyof typeof DEVICE_KIND];

/** The stella desktop app names itself in its own HTTP client's user agent. */
const DESKTOP_APP = /\bstella-desktop\b/iu;
const TABLET = /iPad|Tablet|Android(?!.*\bMobile\b)/u;
const PHONE = /iPhone|iPod|Android.*\bMobile\b|Windows Phone/u;
const COMPUTER = /Windows NT|Macintosh|Mac OS X|CrOS|X11|Linux x86_64/u;

export const parseDeviceKind = (ua: string | null | undefined): DeviceKind => {
  if (!ua) {
    return DEVICE_KIND.unknown;
  }
  if (DESKTOP_APP.test(ua)) {
    return DEVICE_KIND.desktopApp;
  }
  // Tablets first: an Android tablet carries no `Mobile` token, a phone does.
  if (TABLET.test(ua)) {
    return DEVICE_KIND.tablet;
  }
  if (PHONE.test(ua)) {
    return DEVICE_KIND.phone;
  }
  return COMPUTER.test(ua) ? DEVICE_KIND.computer : DEVICE_KIND.unknown;
};
