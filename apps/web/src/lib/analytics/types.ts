export const WEB_ANALYTICS_EVENTS = {
  exception: "$exception",
  identify: "$identify",
  pageViewed: "page_viewed",
} as const;

export type WebAnalyticsEvent =
  (typeof WEB_ANALYTICS_EVENTS)[keyof typeof WEB_ANALYTICS_EVENTS];

export type Analytics = {
  captureError: (error: unknown) => void;
  capturePageViewed: (properties: PageViewedProperties) => void;
  identifyUser: (user: AnalyticsUserIdentity) => void;
  reset: (options?: AnalyticsResetOptions) => void;
};

export type AnalyticsResetOptions = {
  onlyIfIdentified?: boolean;
};

export type PageViewedProperties = {
  href: string;
  path: string;
};

export type AnalyticsUserIdentity = {
  id: string;
  email?: string;
  name?: string;
};
