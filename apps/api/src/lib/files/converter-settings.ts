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

/** Build the converter endpoint from a process-validated service origin. */
export const gotenbergConvertTarget = (settings: ConverterSettings): URL =>
  new URL("/forms/libreoffice/convert", settings.GOTENBERG_URL);
