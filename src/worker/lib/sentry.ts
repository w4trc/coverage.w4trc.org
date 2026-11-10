import { Toucan } from "toucan-js";

/**
 * Optional error tracking. Returns null (and does nothing at all) unless the
 * SENTRY_DSN secret is set. IPs, cookies, request bodies and query strings are
 * never sent, so report comments and reporter locations stay out of Sentry.
 */
export function initSentry(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Toucan | null {
  if (!env.SENTRY_DSN) return null;
  return new Toucan({
    dsn: env.SENTRY_DSN,
    context: ctx,
    request,
    release: env.APP_VERSION,
    environment: env.ENVIRONMENT,
    requestDataOptions: {
      allowedHeaders: ["user-agent"],
      allowedCookies: false,
      allowedSearchParams: false,
      allowedIps: false,
    },
    beforeSend(event) {
      delete event.user;
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
      }
      return event;
    },
  });
}
