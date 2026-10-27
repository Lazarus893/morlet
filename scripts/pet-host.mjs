#!/usr/bin/env node
// Reuse dsh-pet's official standalone entry point with instance-local state.
import { readFileSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const path = resolve(process.argv[3] || '');
if (process.argv.length !== 4 || process.argv[2] !== '--config' || path !== join(root, '.runtime/pet-host.json')) throw new Error('INVALID_CONFIG');
const stat = lstatSync(path);
if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid() || stat.size > 4096) throw new Error('PRIVATE_CONFIG_REQUIRED');
const config = JSON.parse(readFileSync(path, 'utf8'));
const home = join(root, '.runtime/pet-home');
if (config.home !== home || typeof config.electron !== 'string' || !config.electron.startsWith('/')) throw new Error('INVALID_CONFIG');
process.env.DSH_HOME = home;
process.env.DSH_PET_ELECTRON_PATH = config.electron;
process.env.DSH_PET_USER_DATA = join(home, 'chromium');
mkdirSync(process.env.DSH_PET_USER_DATA, { recursive: true, mode: 0o700 });
const entry = join(root, '.runtime/pet-package/node_modules/dsh-pet/lib/standalone.js');
// Keep process argv unchanged for exact launchctl identity checks. The upstream
// parser receives its args only during module initialization, then we restore it.
const argv = process.argv;
process.argv = [argv[0], entry, '--port', '3080'];
try { await import(pathToFileURL(entry).href); } finally { process.argv = argv; }
