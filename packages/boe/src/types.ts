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

export type BoeStatus = {
  code?: string;
  text?: string;
};

export type BoeSearchResponse = {
  data?: BoeSearchHit[];
  status?: BoeStatus;
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
  status?: BoeStatus;
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
  /** Raw XML — the BOE /texto endpoint serves application/xml only. */
  fullText: string | null;
  /** Raw XML — the BOE /metadata-eli endpoint serves application/xml only. */
  eli: string | null;
};

// ---------------------------------------------------------------------------
// BORME daily summary
// ---------------------------------------------------------------------------

export type BormeAnnouncement = {
  identificador?: string;
  titulo?: string;
  url_pdf?: {
    pagina_final?: string;
    pagina_inicial?: string;
    szBytes?: string;
    szKBytes?: string;
    texto?: string;
  };
  url_html?: string;
  url_xml?: string;
};

export type BormeSectionGroup = {
  codigo?: string;
  nombre?: string;
  item?: BormeAnnouncement[] | BormeAnnouncement;
};

export type BormeProvincialSection = {
  apartado?: BormeSectionGroup[] | BormeSectionGroup;
  codigo?: string;
  item?: BormeAnnouncement[] | BormeAnnouncement;
  nombre?: string;
};

export type BormeDailyIssue = {
  numero?: string;
  seccion?: BormeProvincialSection[] | BormeProvincialSection;
  sumario_diario?: {
    identificador?: string;
    url_pdf?: { szBytes?: string; szKBytes?: string; texto?: string };
  };
};

export type BormeSummaryResponse = {
  data?: {
    sumario?: {
      diario?: BormeDailyIssue[] | BormeDailyIssue;
      metadatos?: {
        fecha_publicacion?: string;
        publicacion?: string;
      };
    };
  };
  status?: BoeStatus;
};

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export type BoeErrorResponse = {
  status?: BoeStatus;
  data?: { description?: string } | null;
};
