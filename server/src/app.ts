import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';
import { routes } from './routes';
import obligateCallbackRoutes from './routes/obligateCallback.routes';
import { obligateService } from './services/obligate.service';

const PgSession = connectPgSimple(session);

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ frameguard: false, contentSecurityPolicy: false }));
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.use(session({
    store: new PgSession({ conString: config.databaseUrl, createTableIfMissing: true }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
    },
  }));

  app.use(apiLimiter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', app: 'oblihub' });
  });

  // Obligate SSO routes (mounted at /auth, before /api)
  app.use('/auth', obligateCallbackRoutes);

  // Also expose SSO config under /api/auth for the client
  app.get('/api/auth/sso-config', async (_req, res) => {
    try {
      const ssoConfig = await obligateService.getSsoConfig();
      res.json({ success: true, data: ssoConfig });
    } catch { res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false } }); }
  });

  app.use('/api', routes);
  app.use(errorHandler);

  return app;
}
