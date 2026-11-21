export const basicAuthorizationHeader = (
  username: string,
  password: string,
): string => `Basic ${Buffer.from(`${username}:${password}`).toBase64()}`;
