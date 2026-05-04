export const WEB_ANALYTICS_EVENTS = {
  exception: "$exception",
  identify: "$identify",
  pagePerformance: "page_performance",
  pageViewed: "page_viewed",
} as const;

export type WebAnalyticsEvent =
  (typeof WEB_ANALYTICS_EVENTS)[keyof typeof WEB_ANALYTICS_EVENTS];

export type Analytics = {
  captureError: (error: unknown) => void;
  capturePagePerformance: (properties: PagePerformanceProperties) => void;
  capturePageViewed: (properties: PageViewedProperties) => void;
  identifyUser: (user: AnalyticsUserIdentity) => void;
  reset: () => void;
};

export type PageViewedProperties = {
  routeId: string;
};

export type PagePerformanceProperties = PageViewedProperties & {
  loadBucket: string;
};

export type AnalyticsUserIdentity = {
  id: string;
  email?: string;
  name?: string;
};
