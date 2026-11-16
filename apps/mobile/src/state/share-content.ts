import type { ShareContent } from "react-native";

/**
 * What the share sheet gets for one link. iOS shares `message` and `url` as
 * two items when both are set (the sheet reads "2 Links" and Copy copies the
 * link twice), and Android reads only `message`; so each platform gets the
 * one field it shares.
 */
export const linkShareContent = (
  url: string,
  os: "ios" | "android" | "web" | "windows" | "macos",
): ShareContent => (os === "ios" ? { url } : { message: url });
