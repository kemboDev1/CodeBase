import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { setRoots, getRoots } from './paths.js';
import { logger } from './logger.js';

const log = logger.make('workspace');

/**
 * Canonical workspace-root computation.
 *
 * Roots are the folders the agent may touch: the user-configured list plus every
 * project root. When the user has configured nothing yet, a `<dataDir>/workspace`
 * folder is created so the file tools work out of the box instead of refusing every
 * read with "no workspace selected".
 *
 * Every caller (server bootstrap, project routes, settings routes) must use this so
 * the list can never be wiped by an empty computation.
 */
export async function computeRoots({ store, dataDir = config.dataDir } = {}) {
  const configured = (store?.settings?.workspaceRoots || []).filter(Boolean);
  const projectRoots = (store?.projects || []).map((project) => project.root).filter(Boolean);
  const roots = [...configured, ...projectRoots];

  if (roots.length) {
    setRoots(roots);
    return getRoots();
  }

  const fallback = path.join(dataDir, 'workspace');
  await fs.mkdir(fallback, { recursive: true });
  setRoots([fallback]);
  log.info(`Workspace root belgilanmagan — standart papka ishlatiladi: ${fallback}`);
  return getRoots();
}

export default computeRoots;
