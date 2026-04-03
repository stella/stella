/**
 * Base URL for the Stella API. In production, set
 * VITE_API_BASE in the build environment.
 */
export const API_BASE: string =
  import.meta.env.VITE_API_BASE ?? "http://localhost:3001";
