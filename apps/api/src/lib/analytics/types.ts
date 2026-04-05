type CaptureParams = {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
};

type IdentifyParams = {
  distinctId: string;
  properties: Record<string, string>;
};

export type Analytics = {
  capture: (params: CaptureParams) => void;
  identify: (params: IdentifyParams) => void;
  /** Flush queued events. No-op for providers without a queue. */
  flush: () => Promise<void>;
};
