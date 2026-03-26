export type Analytics = {
  capture: (event: string, properties?: Record<string, unknown>) => void;
  captureError: (error: unknown) => void;
};
