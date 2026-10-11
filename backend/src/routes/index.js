import { Router } from 'express';
import { createSystemRoutes } from './system.js';
import { createProjectRoutes } from './projects.js';
import { createAgentRoutes } from './agent.js';
import { createLibraryRoutes } from './library.js';
import { createFileRoutes } from './files.js';
import { createTerminalRoutes } from './terminal.js';
import { createSettingsRoutes } from './settings.js';

/** Mount every API route. `deps` is assembled once in server.js. */
export function createApiRouter(deps) {
  const router = Router();

  router.use(createSystemRoutes(deps));
  router.use(createProjectRoutes(deps));
  router.use(createSettingsRoutes(deps));
  router.use(createAgentRoutes(deps));
  router.use(createLibraryRoutes(deps));
  router.use(createFileRoutes(deps));
  router.use(createTerminalRoutes(deps));

  router.use((req, res) => {
    res.status(404).json({ error: `API yo‘li topilmadi: ${req.method} /api${req.path}` });
  });

  return router;
}

export default createApiRouter;
