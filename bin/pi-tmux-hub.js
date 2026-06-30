#!/usr/bin/env node

import { main } from '../src/hub.js';

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`pi-tmux-hub: ${message}`);
  process.exitCode = 1;
});
