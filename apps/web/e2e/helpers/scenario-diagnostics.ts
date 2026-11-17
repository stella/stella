export const networkRequestLabel = (method: string, rawUrl: string): string => {
  const url = new URL(rawUrl);
  return `${method} ${url.origin}${url.pathname}`;
};

export const isNon2xxStatus = (status: number): boolean =>
  status < 200 || status >= 300;
