// ---------------------------------------------------------------------------
// Raw INEGI DENUE API response shapes.
//
// DENUE (Directorio Estadistico Nacional de Unidades Economicas) is
// Mexico's official statistical directory of active economic units.
// It is not the Registro Publico de Comercio corporate-law register:
// records are establishments / branches, keyed by DENUE `Id` and
// optionally `CLEE`, with name, legal name, activity, size, contact,
// and location data.
//
// Public docs: https://www.inegi.org.mx/servicios/api_denue.html
// API base: https://www.inegi.org.mx/app/api/denue/v1/consulta
// ---------------------------------------------------------------------------

export type DenueRawEstablishment = {
  CLEE?: string;
  Id: string;
  Nombre: string;
  Razon_social?: string;
  Clase_actividad?: string;
  Estrato?: string;
  Tipo_vialidad?: string;
  Calle?: string;
  Num_Exterior?: string;
  Num_Interior?: string;
  Colonia?: string;
  CP?: string;
  Ubicacion?: string;
  Telefono?: string;
  Correo_e?: string;
  Sitio_internet?: string;
  Tipo?: string;
  Longitud?: string;
  Latitud?: string;
  CentroComercial?: string;
  TipoCentroComercial?: string;
  NumLocal?: string;
};

export type DenueErrorResponse = string[];
export type DenueResponse = DenueRawEstablishment[] | DenueErrorResponse;

export type DenueCoordinates = {
  latitude: number | null;
  longitude: number | null;
};

export type DenueAddress = {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  locality: string | null;
  municipality: string | null;
  state: string | null;
  country: "MX";
  textAddress: string | null;
};

export type DenueEstablishment = {
  id: string;
  clee: string | null;
  name: string;
  legalName: string | null;
  activityClass: string | null;
  employeeStratum: string | null;
  unitType: string | null;
  address: DenueAddress | null;
  coordinates: DenueCoordinates;
  phone: string | null;
  email: string | null;
  website: string | null;
  shoppingCenter: string | null;
  shoppingCenterType: string | null;
  unitNumber: string | null;
  registryUrl: string;
};

export type DenueSearchResult = Pick<
  DenueEstablishment,
  | "id"
  | "clee"
  | "name"
  | "legalName"
  | "activityClass"
  | "employeeStratum"
  | "unitType"
  | "coordinates"
  | "registryUrl"
> & {
  address: string | null;
};
