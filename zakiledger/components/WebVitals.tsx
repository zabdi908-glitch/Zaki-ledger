"use client";

import { useReportWebVitals } from "next/web-vitals";

/** Fire-and-forget vitals beacon. sendBeacon survives page navigation, which
 * is exactly when LCP/CLS values are finalized. */
export default function WebVitals() {
  useReportWebVitals((metric) => {
    const body = JSON.stringify({
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      path: window.location.pathname,
    });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/vitals", body);
    else fetch("/api/vitals", { method: "POST", body, keepalive: true });
  });
  return null;
}
