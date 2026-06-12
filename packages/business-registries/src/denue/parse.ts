import type {
  DenueAddress,
  DenueCoordinates,
  DenueEstablishment,
  DenueRawEstablishment,
  DenueSearchResult,
} from "./types.js";

const DENUE_WEB_BASE = "https://www.inegi.org.mx/app/mapa/denue/default.aspx";
const MEXICO_COUNTRY = "MX" as const;

const emptyToNull = (input: string | undefined): string | null => {
  const trimmed = input?.trim();
  if (!trimmed || trimmed === "0") {
    return null;
  }
  return trimmed;
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

const parseLocation = (
  rawLocation: string | undefined,
): {
  locality: string | null;
  municipality: string | null;
  state: string | null;
  text: string | null;
} => {
  const text = emptyToNull(rawLocation);
  if (!text) {
    return {
      locality: null,
      municipality: null,
      state: null,
      text: null,
    };
  }
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    locality: parts.at(0) ?? null,
    municipality: parts.at(1) ?? null,
    state: parts.at(2) ?? null,
    text,
  };
};

const parseCoordinates = (raw: DenueRawEstablishment): DenueCoordinates => ({
  latitude: numberOrNull(raw.Latitud),
  longitude: numberOrNull(raw.Longitud),
});

const parseAddress = (raw: DenueRawEstablishment): DenueAddress | null => {
  const streetType = emptyToNull(raw.Tipo_vialidad);
  const street = emptyToNull(raw.Calle);
  const exterior = emptyToNull(raw.Num_Exterior);
  const interior = emptyToNull(raw.Num_Interior);
  const neighborhood = emptyToNull(raw.Colonia);
  const location = parseLocation(raw.Ubicacion);

  const line1 = [streetType, street, exterior].filter(Boolean).join(" ");
  const line2 = [interior ? `Int. ${interior}` : null, neighborhood]
    .filter(Boolean)
    .join(", ");
  const textAddress = [
    line1 || null,
    line2 || null,
    emptyToNull(raw.CP) ? `CP ${emptyToNull(raw.CP)}` : null,
    location.text,
  ]
    .filter(Boolean)
    .join(", ");

  if (!line1 && !line2 && !raw.CP && !location.text) {
    return null;
  }
  return {
    line1: line1 || null,
    line2: line2 || null,
    postalCode: emptyToNull(raw.CP),
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
    clee: emptyToNull(raw.CLEE),
    name: emptyToNull(raw.Nombre) ?? id,
    legalName: emptyToNull(raw.Razon_social),
    activityClass: emptyToNull(raw.Clase_actividad),
    employeeStratum: emptyToNull(raw.Estrato),
    unitType: emptyToNull(raw.Tipo),
    address: parseAddress(raw),
    coordinates: parseCoordinates(raw),
    phone: emptyToNull(raw.Telefono),
    email: emptyToNull(raw.Correo_e),
    website: emptyToNull(raw.Sitio_internet),
    shoppingCenter: emptyToNull(raw.CentroComercial),
    shoppingCenterType: emptyToNull(raw.TipoCentroComercial),
    unitNumber: emptyToNull(raw.NumLocal),
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
