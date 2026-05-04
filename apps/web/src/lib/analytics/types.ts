export const WEB_ANALYTICS_EVENTS = {
  exception: "$exception",
  pagePerformance: "page_performance",
  pageViewed: "page_viewed",
} as const;

export type WebAnalyticsEvent =
  (typeof WEB_ANALYTICS_EVENTS)[keyof typeof WEB_ANALYTICS_EVENTS];

export type Analytics = {
  captureError: (error: unknown) => void;
  capturePagePerformance: (properties: PagePerformanceProperties) => void;
  capturePageViewed: (properties: PageViewedProperties) => void;
};

export type PageViewedProperties = {
  routeId: string;
};

export type PagePerformanceProperties = PageViewedProperties & {
  loadBucket: string;
};
