import * as v from "valibot";

export const converterSettingsSchema = {
  GOTENBERG_URL: v.pipe(v.string(), v.url()),
  GOTENBERG_USERNAME: v.string(),
  GOTENBERG_PASSWORD: v.string(),
};

export type ConverterSettings = v.InferOutput<
  v.ObjectSchema<typeof converterSettingsSchema, undefined>
>;

/**
 * Build the converter endpoint from a process-validated service URL. The
 * route is appended to the configured path, so a converter behind a
 * reverse-proxy prefix keeps that prefix.
 */
export const gotenbergConvertTarget = (settings: ConverterSettings): URL => {
  const target = new URL(settings.GOTENBERG_URL);
  let pathEnd = target.pathname.length;
  while (pathEnd > 0 && target.pathname[pathEnd - 1] === "/") {
    pathEnd -= 1;
  }
  target.pathname = `${target.pathname.slice(0, pathEnd)}/forms/libreoffice/convert`;
  target.search = "";
  target.hash = "";
  return target;
};
