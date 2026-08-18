import fs from 'fs';

export function isContainerRuntime() {
  return process.env.OPTICS_AGENT_RUNTIME === 'container' || fs.existsSync('/.dockerenv');
}
