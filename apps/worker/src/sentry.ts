import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
const enabled = process.env.NODE_ENV === 'production' && Boolean(dsn);

if (enabled) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    environment: process.env.FLY_APP_NAME ?? 'unknown',
  });
}

export { Sentry, enabled as sentryEnabled };
