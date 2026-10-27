import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const [entry, output] of [['plugins/webui/surfaces.jsx', 'plugins/webui/public/journal-surfaces.js'], ['plugins/webui/motion.mjs', 'plugins/webui/public/motion.js']]) {
 const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: resolve(root, output), bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['safari16', 'chrome110'], legalComments: 'external', metafile: true, write: false, define: { 'process.env.NODE_ENV': '"production"' } });
 // Include the licenses of the modules actually bundled, including components'
 // transitive dependencies. Adding an official component cannot omit its notice.
 const packages = [...new Set(Object.keys(result.metafile.inputs).map(path => path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean))].sort();
 const notices = [];
 for (const name of packages) {
  let license;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'license.txt', 'License', 'LICENSE-MIT']) {
   try { license = await readFile(resolve(root, 'node_modules', name, file), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license && name === 'format') {
   const readme = await readFile(resolve(root, 'node_modules/format/Readme.md'), 'utf8');
   const mit = await readFile(resolve(root, 'node_modules/react/LICENSE'), 'utf8');
   license = readme.slice(readme.lastIndexOf('License\n')) + '\n' + mit.slice(mit.indexOf('Permission is hereby granted'));
  }
  if (!license) throw new Error(`Missing license for bundled package: ${name}`);
  notices.push(`\n--- ${name} ---\n${license}`);
 }
 const licensePath = resolve(root, output + '.LEGAL.txt');
 // esbuild omits this file when no legal comments were extracted. Rebuild it
 // from this build's output so old dependency notices cannot accumulate.
 const extracted = result.outputFiles.find(file => file.path === licensePath)?.text || '';
 for (const file of result.outputFiles) if (file.path !== licensePath) await writeFile(file.path, file.contents);
 await writeFile(licensePath, extracted + '\n\nFull dependency licenses:\n' + notices.join('\n'));
 console.log(`${output}: ${packages.length} dependency licenses included`);
}
