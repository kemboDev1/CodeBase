import os from 'node:os';
import * as ollama from '../../ollama/client.js';
import { config } from '../../config.js';
import { getRoots } from '../../lib/paths.js';
import { humanBytes } from '../../lib/text.js';

const def = (name, title, description, parameters, run) => ({
  name, title, description, category: 'system', defaultPolicy: 'allow', parameters, run, source: 'core'
});

export const systemInfo = def(
  'system.info',
  'System info',
  'Report the environment: OS, shell, workspace roots, available models, configured models and tool count.',
  { type: 'object', properties: {}, required: [] },
  async (_args, ctx) => {
    const models = await ollama.listModels().catch(() => []);
    return {
      ok: true,
      summary: `${os.platform()} · ${models.length} model · ${ctx.registry.size()} tool`,
      content: [
        `CodeBase Agent v${config.version}`,
        `platform: ${os.platform()} ${os.release()} (${os.arch()})`,
        `host: ${os.hostname()}`,
        `free memory: ${humanBytes(os.freemem())} / ${humanBytes(os.totalmem())}`,
        `shell: ${process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'}`,
        `workspace roots: ${getRoots().join(' | ') || '(yo‘q)'}`,
        `project root: ${ctx.projectRoot || '(yo‘q)'}`,
        `models (${models.length}): ${models.map((model) => model.name).join(', ') || '—'}`,
        `main model: ${config.defaultModel} · fast model: ${config.fastModel}`,
        `tools registered: ${ctx.registry.size()}`
      ].join('\n'),
      data: { platform: os.platform(), models: models.map((model) => model.name), tools: ctx.registry.size() }
    };
  }
);

export const systemOllama = def(
  'system.ollama_status',
  'Ollama status',
  'Check whether the local Ollama server is reachable and list available models.',
  { type: 'object', properties: {}, required: [] },
  async () => {
    const status = await ollama.health();
    return {
      ok: status.connected,
      summary: status.connected ? `Ollama online — ${status.models.length} model` : `Ollama offline: ${status.error || 'ulanmadi'}`,
      content: status.connected
        ? [`Ollama: ${status.url}`, ...status.models.map((model) => `- ${model.name} (${humanBytes(model.size)})${model.tools ? ' [tools]' : ''}`)].join('\n')
        : `Ollama offline (${status.url}): ${status.error || 'javob yo‘q'}`,
      data: status,
      error: status.connected ? undefined : status.error
    };
  }
);

export const systemTools = [systemInfo, systemOllama];
export default systemTools;
