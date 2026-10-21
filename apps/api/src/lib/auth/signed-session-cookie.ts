/** Returns the value better-auth expects for a signed session cookie. */
export const createSignedSessionCookieValue = (
  token: string,
  secret: string,
): string => {
  const signature = new Bun.CryptoHasher("sha256", secret)
    .update(token)
    .digest("base64");
  return `${token}.${signature}`;
};
