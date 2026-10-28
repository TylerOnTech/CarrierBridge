import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { CarrierRegistry } from '../carriers/registry.js';
import type { Logger } from '../logging/logger.js';
import type { PrismaClient } from '../persistence/prisma.js';
import type { PullService } from '../services/pull-service.js';
import { requestId } from './middleware/request-id.js';
import { buildOpenApiDocument } from './openapi.js';
import { errorHandler, notFoundHandler } from './problem.js';
import { carriersRouter } from './routes/carriers.js';
import { healthRouter } from './routes/health.js';
import { policiesRouter } from './routes/policies.js';
import { pullsRouter } from './routes/pulls.js';

export interface AppDeps {
  logger: Logger;
  prisma: PrismaClient;
  registry: CarrierRegistry;
  pullService: PullService;
  isShuttingDown: () => boolean;
}

/** Routing layer only: parse, delegate to the service, present. No business logic here. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: '64kb' }));

  const openApi = buildOpenApiDocument();
  app.get('/openapi.json', (_req, res) => {
    res.json(openApi);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApi, { customSiteTitle: 'CarrierBridge API' }));

  app.use(healthRouter(deps));
  app.use(carriersRouter(deps.registry));
  app.use(pullsRouter(deps.pullService));
  app.use(policiesRouter(deps.pullService));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
