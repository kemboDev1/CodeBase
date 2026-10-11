import { fsTools } from './fs.js';
import { searchTools } from './search.js';
import { shellTools } from './shell.js';
import { gitTools } from './git.js';
import { testTools } from './tests.js';
import { webTools } from './web.js';
import { memoryTools } from './memory.js';
import { skillTools } from './skills.js';
import { systemTools } from './system.js';

export const coreTools = [
  ...fsTools,
  ...searchTools,
  ...shellTools,
  ...gitTools,
  ...testTools,
  ...webTools,
  ...memoryTools,
  ...skillTools,
  ...systemTools
];

/** Register every built-in tool into a registry. Returns the list of registered names. */
export function registerCoreTools(registry, { logger } = {}) {
  const log = logger || { debug() {}, warn() {} };
  const registered = [];
  for (const tool of coreTools) {
    try {
      registry.register(tool);
      registered.push(tool.name);
    } catch (error) {
      log.warn(`Tool ro‘yxatga olinmadi (${tool.name}): ${error.message}`);
    }
  }
  log.debug(`${registered.length} core tool ro‘yxatga olindi.`);
  return registered;
}

export default registerCoreTools;
