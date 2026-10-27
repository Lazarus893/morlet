#!/usr/bin/env node
// Run on the isolated directory created by `pnpm patch`, never node_modules.
import { readFileSync, copyFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = realpathSync(resolve(process.argv[2] || ''));
if (!process.argv[2] || dir.split('/').includes('node_modules')) throw new Error('Use an isolated pnpm patch directory');
const vendor = join(root, 'vendor/dsh-pet'), metadata = JSON.parse(readFileSync(join(vendor, 'upstream.json')));
const pkg = JSON.parse(readFileSync(join(dir, 'package.json')));
if (pkg.name !== metadata.package || pkg.version !== metadata.version) throw new Error('Unsupported upstream version');
for (const [path, hash] of Object.entries(metadata.files)) if (createHash('sha256').update(readFileSync(join(dir, path))).digest('hex') !== hash) throw new Error('Upstream source changed: ' + path);
execFileSync('patch', ['--batch', '-p1', '-i', join(vendor, 'chat.patch')], { cwd: dir, stdio: 'inherit' });
execFileSync('patch', ['--batch', '-p1', '-i', join(vendor, 'standalone.patch')], { cwd: dir, stdio: 'inherit' });
copyFileSync(join(vendor, 'xiaoman-chat.mjs'), join(dir, 'src/host/xiaoman-chat.mjs'));
copyFileSync(join(vendor, 'xiaoman-chat-ui.ts'), join(dir, 'src/shared/xiaoman-chat-ui.ts'));
await build({ entryPoints: [join(dir, 'src/host/index.ts')], outfile: join(dir, 'lib/index.js'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22' });
await build({ entryPoints: [join(dir, 'src/client/index.ts')], outfile: join(dir, 'lib/client.js'), bundle: true, packages: 'external', platform: 'browser', format: 'esm', target: 'chrome110' });
await build({ entryPoints: [join(dir, 'src/shared/index.ts')], outfile: join(dir, 'runtime/electron-helper/shared-core.js'), bundle: true, platform: 'browser', format: 'iife', globalName: 'PetShared', target: 'chrome110' });
await build({ entryPoints: [join(dir, 'src/standalone/cli.ts')], outfile: join(dir, 'lib/standalone.js'), bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22',
  alias: Object.fromEntries(['dsh-home-paths', 'dsh-credentials', 'dsh-llm'].map(name => ['@deepseek-ai/' + name, join(dir, 'src/standalone/shims', name + '.ts')])) });
console.log('Built the pinned pet chat extension. Apply with pnpm patch-commit.');
