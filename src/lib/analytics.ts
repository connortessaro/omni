/**
 * Zero-Telemetry Analytics Interface (Privacy-First)
 * Omni does not track users or collect telemetry.
 */
export const ANALYTICS_EVENTS = {
  APP_STARTED: "app_started",
  GET_LICENSE: "get_license",
} as const;

export const captureEvent = async (
  _eventName: string,
  _properties?: Record<string, any>
) => {
  // Zero-telemetry: No-op for privacy
};

export const trackAppStart = async (_appVersion: string, _instanceId: string) => {
  // Zero-telemetry: No-op for privacy
};

