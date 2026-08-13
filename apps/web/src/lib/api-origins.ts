import { env } from "@/env";

export const externalApiOrigin = (): string => env.VITE_API_URL;

export const browserApiBaseUrl = (): string =>
  env.VITE_BROWSER_API_URL ?? externalApiOrigin();

export const browserAuthBaseUrl = (): string => {
  if (env.VITE_BROWSER_API_URL === undefined) {
    return externalApiOrigin();
  }
  return new URL(env.VITE_BROWSER_API_URL).origin;
};

export const browserApiRootUrl = (path: `/${string}`): string => {
  if (env.VITE_BROWSER_API_URL === undefined) {
    return new URL(path, externalApiOrigin()).toString();
  }
  return `${env.VITE_BROWSER_API_URL}${path}`;
};
