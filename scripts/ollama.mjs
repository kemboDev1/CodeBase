/**
 * Ollama helper CLI — the same code the app uses (backend/src/system/ollama.js).
 *
 *   node scripts/ollama.mjs status     # is Ollama running? is autostart enabled?
 *   node scripts/ollama.mjs enable     # start Ollama now + register Windows autostart
 *   node scripts/ollama.mjs disable    # remove the autostart entry
 *   node scripts/ollama.mjs start      # start Ollama now (no autostart change)
 *   node scripts/ollama.mjs stop       # stop the local Ollama server
 */

import { ensureStarted, setAutostart, status, stop, findOllamaExecutable } from '../backend/src/system/ollama.js';

const command = (process.argv[2] || 'status').toLowerCase();

const print = (label, value) => {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
};

switch (command) {
  case 'enable': {
    const exe = findOllamaExecutable();
    print('Ollama exe', exe || 'topilmadi');
    const autostart = await setAutostart(true);
    print('Autostart', autostart);
    const started = await ensureStarted();
    print('Start', started);
    print('Status', await status());
    break;
  }
  case 'disable':
    print('Autostart', await setAutostart(false));
    break;
  case 'start':
    print('Start', await ensureStarted({ force: true }));
    break;
  case 'stop':
    print('Stop', await stop());
    break;
  default:
    print('Status', await status());
    break;
}
