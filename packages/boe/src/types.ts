// ---------------------------------------------------------------------------
// Search response (legislacion-consolidada)
// ---------------------------------------------------------------------------

export type BoeSearchHit = {
  identificador: string;
  titulo?: string;
  fecha_publicacion?: string;
  fecha_disposicion?: string;
  departamento?: { codigo?: string; texto?: string };
  rango?: { codigo?: string; texto?: string };
  estado_consolidacion?: { codigo?: string; texto?: string };
  url_eli?: string;
  url_html_consolidada?: string;
};

export type BoeSearchResponse = {
  data?: {
    total?: number;
    offset?: number;
    limit?: number;
    resultados?: BoeSearchHit[];
  };
  status?: string;
};

// ---------------------------------------------------------------------------
// Single-law endpoints
//
// The BOE API returns deeply nested HTML-bearing structures whose exact shape
// varies between sections (metadatos / analisis / texto / metadata-eli).
// We expose them as `unknown` envelopes; consumers narrow on a case-by-case
// basis. Strict typing here would create false confidence and require
// constant maintenance against an undocumented schema.
// ---------------------------------------------------------------------------

export type BoeLawEnvelope = {
  data?: unknown;
  status?: string;
};

export type ConsolidatedLawSections = {
  metadata: boolean;
  analysis: boolean;
  fullText: boolean;
  eli: boolean;
};

export type ConsolidatedLawResult = {
  lawId: string;
  metadata: unknown;
  analysis: unknown;
  fullText: unknown;
  eli: unknown;
};

// ---------------------------------------------------------------------------
// BORME daily summary
// ---------------------------------------------------------------------------

export type BormeAnnouncement = {
  identificador?: string;
  titulo?: string;
  url_pdf?: { texto?: string };
  url_html?: string;
};

export type BormeProvincialSection = {
  codigo?: string;
  nombre?: string;
  items?: { item?: BormeAnnouncement[] | BormeAnnouncement };
};

export type BormeSummaryResponse = {
  data?: {
    sumario?: {
      diario?: {
        sumario_diario?: {
          fecha?: string;
          seccion?: BormeProvincialSection[] | BormeProvincialSection;
        };
      }[];
    };
  };
  status?: string;
};

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export type BoeErrorResponse = {
  status?: { code?: string; text?: string };
  data?: { description?: string } | null;
};
