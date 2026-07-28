import { performRegistryRequest } from "../shared/http.js";
import {
  SudregAPIError,
  SudregRequestError,
  SudregValidationError,
} from "./errors.js";
import { parseCompanyPage } from "./parse.js";
import type { SudregCompany } from "./types.js";
import { normalizeMbs, validateMbs } from "./validation.js";

const companyUrl = (mbs: string): string =>
  `https://sudreg.pravosudje.hr/ords/r/esudreg/public/28?p28_sbt_mbs=${encodeURIComponent(mbs)}`;

export const lookupByMbs = async (
  mbsInput: string,
): Promise<SudregCompany | null> => {
  const mbs = normalizeMbs(mbsInput);
  if (!validateMbs(mbs)) {
    throw new SudregValidationError(`Invalid Croatian MBS: ${mbsInput}`);
  }
  const url = companyUrl(mbs);
  const response = await performRegistryRequest({
    url,
    init: { headers: { Accept: "text/html" } },
    wrapRequestError: (cause) =>
      new SudregRequestError(url, "SUDREG request failed", { cause }),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new SudregAPIError({
      message: `SUDREG ${response.status}: ${response.statusText}`,
      httpStatus: response.status,
    });
  }

  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    throw new SudregAPIError({
      message: "SUDREG response body was unreadable",
      httpStatus: response.status,
      cause: error,
    });
  }
  if (html.trim().length === 0) {
    throw new SudregAPIError({
      message: "SUDREG returned an empty response",
      httpStatus: response.status,
    });
  }
  return parseCompanyPage(html, mbs);
};
