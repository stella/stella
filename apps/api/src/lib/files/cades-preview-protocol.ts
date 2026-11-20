export const CADES_WORKER_MODE = {
  preview: "cades-preview",
  pdf: "cades-pdf",
} as const;

export type CadesWorkerMode =
  (typeof CADES_WORKER_MODE)[keyof typeof CADES_WORKER_MODE];

export const CADES_WORKER_EXIT = {
  unreadable: 20,
  rejected: 21,
} as const;
