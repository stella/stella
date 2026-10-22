import * as v from "valibot";

export const converterSettingsSchema = {
  GOTENBERG_URL: v.pipe(v.string(), v.url()),
  GOTENBERG_USERNAME: v.string(),
  GOTENBERG_PASSWORD: v.string(),
};

export type ConverterSettings = {
  GOTENBERG_PASSWORD: string;
  GOTENBERG_URL: string;
  GOTENBERG_USERNAME: string;
};

/**
 * Build the converter endpoint from a process-validated service URL. The
 * route is appended to the configured path, so a converter behind a
 * reverse-proxy prefix keeps that prefix.
 */
export const gotenbergConvertTarget = (settings: ConverterSettings): URL => {
  const target = new URL(settings.GOTENBERG_URL);
  target.pathname = `${target.pathname.replace(/\/+$/u, "")}/forms/libreoffice/convert`;
  target.search = "";
  target.hash = "";
  return target;
};
