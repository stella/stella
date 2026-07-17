import { trimToNull } from "../shared/strings.js";
import type {
  DenueAddress,
  DenueCoordinates,
  DenueEstablishment,
  DenueRawEstablishment,
  DenueSearchResult,
} from "./types.js";

const DENUE_WEB_BASE = "https://www.inegi.org.mx/app/mapa/denue/default.aspx";
const MEXICO_COUNTRY = "MX" as const;

// DENUE emits "0" as an absent-value sentinel for the postal code (there
// is no CP 00000), so we collapse it to null. This is deliberately NOT
// applied to the general string fields: a blanket `=== "0"` rule used to
// discard legitimate "0" address atoms (a house or local number can be
// "0"). Every other field uses plain `trimToNull`, matching the GCIS
// adapter and the shared helper.
const postalCodeToNull = (input: string | undefined): string | null => {
  const trimmed = trimToNull(input);
  return trimmed === "0" ? null : trimmed;
};

const numberOrNull = (input: string | undefined): number | null => {
  const trimmed = input?.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
};

const buildRegistryUrl = (id: string): string =>
  `${DENUE_WEB_BASE}?idee=${encodeURIComponent(id)}`;

type ParseLocationResult = {
  locality: string | null;
  municipality: string | null;
  state: string | null;
  text: string | null;
};

const parseLocation = (
  rawLocation: string | undefined,
): ParseLocationResult => {
  const text = trimToNull(rawLocation);
  if (!text) {
    return {
      locality: null,
      municipality: null,
      state: null,
      text: null,
    };
  }
  const parts = text.split(",").flatMap((part) => {
    const trimmed = part.trim();
    return trimmed ? [trimmed] : [];
  });
  return {
    locality: parts.length > 2 ? parts.slice(0, -2).join(", ") : null,
    municipality: parts.length > 1 ? (parts.at(-2) ?? null) : null,
    state: parts.at(-1) ?? null,
    text,
  };
};

const parseCoordinates = (raw: DenueRawEstablishment): DenueCoordinates => ({
  latitude: numberOrNull(raw.Latitud),
  longitude: numberOrNull(raw.Longitud),
});

const parseAddress = (raw: DenueRawEstablishment): DenueAddress | null => {
  const streetType = trimToNull(raw.Tipo_vialidad);
  const street = trimToNull(raw.Calle);
  const exterior = trimToNull(raw.Num_Exterior);
  const interior = trimToNull(raw.Num_Interior);
  const neighborhood = trimToNull(raw.Colonia);
  const postalCode = postalCodeToNull(raw.CP);
  const location = parseLocation(raw.Ubicacion);

  const line1 = [streetType, street, exterior].filter(Boolean).join(" ");
  const line2 = [interior ? `Int. ${interior}` : null, neighborhood]
    .filter(Boolean)
    .join(", ");
  const textAddress = [
    line1 || null,
    line2 || null,
    postalCode ? `CP ${postalCode}` : null,
    location.text,
  ]
    .filter(Boolean)
    .join(", ");

  if (!line1 && !line2 && !postalCode && !location.text) {
    return null;
  }
  return {
    line1: line1 || null,
    line2: line2 || null,
    postalCode,
    locality: location.locality,
    municipality: location.municipality,
    state: location.state,
    country: MEXICO_COUNTRY,
    textAddress: textAddress || null,
  };
};

export const parseEstablishment = (
  raw: DenueRawEstablishment,
): DenueEstablishment => {
  const id = raw.Id;
  return {
    id,
    clee: trimToNull(raw.CLEE),
    name: trimToNull(raw.Nombre) ?? id,
    legalName: trimToNull(raw.Razon_social),
    activityClass: trimToNull(raw.Clase_actividad),
    employeeStratum: trimToNull(raw.Estrato),
    unitType: trimToNull(raw.Tipo),
    address: parseAddress(raw),
    coordinates: parseCoordinates(raw),
    phone: trimToNull(raw.Telefono),
    email: trimToNull(raw.Correo_e),
    website: trimToNull(raw.Sitio_internet),
    shoppingCenter: trimToNull(raw.CentroComercial),
    shoppingCenterType: trimToNull(raw.TipoCentroComercial),
    unitNumber: trimToNull(raw.NumLocal),
    registryUrl: buildRegistryUrl(id),
  };
};

export const parseSearchEntry = (
  raw: DenueRawEstablishment,
): DenueSearchResult => {
  const establishment = parseEstablishment(raw);
  return {
    id: establishment.id,
    clee: establishment.clee,
    name: establishment.name,
    legalName: establishment.legalName,
    activityClass: establishment.activityClass,
    employeeStratum: establishment.employeeStratum,
    unitType: establishment.unitType,
    address: establishment.address?.textAddress ?? null,
    coordinates: establishment.coordinates,
    registryUrl: establishment.registryUrl,
  };
};
