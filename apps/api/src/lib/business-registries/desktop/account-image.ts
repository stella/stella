import type { LinkedAccountSnapshot } from "@stll/api-contract/desktop-rpc";

/**
 * The longest picture reference the desktop accepts: a 256 KiB image as
 * base64 with its `data:` header. Keep in step with `MAX_AVATAR_BYTES` in
 * `apps/desktop/src-tauri/src/account_avatar.rs`.
 */
export const DESKTOP_ACCOUNT_IMAGE_MAX_LENGTH =
  4 * Math.ceil((256 * 1024) / 3) + 64;

const RASTER_DATA_URL =
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z\d+/]+={0,2}$/u;

/**
 * The member's picture as the desktop may load it: an `https` URL without
 * credentials, or a base64 raster `data:` URL, within the length cap.
 * Anything else (another scheme, SVG, an oversized value) is no picture.
 */
export const desktopAccountImage = (
  image: string | null | undefined,
): string | null => {
  if (!image || image.length > DESKTOP_ACCOUNT_IMAGE_MAX_LENGTH) {
    return null;
  }
  if (image.startsWith("data:")) {
    return RASTER_DATA_URL.test(image) ? image : null;
  }
  if (!URL.canParse(image)) {
    return null;
  }
  const url = new URL(image);
  return url.protocol === "https:" &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === ""
    ? url.href
    : null;
};

/**
 * What the desktop's account verification answers about the member: the
 * linked account it saves, and beside it the picture it shows. The picture
 * never joins the saved account snapshot.
 */
export const desktopVerifiedAccount = (
  member: { email: string; name: string; image: string | null },
  verifiedAt: string,
): { account: LinkedAccountSnapshot; accountImage: string | null } => ({
  account: { email: member.email, name: member.name, verifiedAt },
  accountImage: desktopAccountImage(member.image),
});
