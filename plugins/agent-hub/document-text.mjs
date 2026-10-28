import { Worker } from 'node:worker_threads';
import { failure } from './store.mjs';

export const DOCUMENT_BYTES = 10 * 1024 * 1024;

// Only already-authorized bytes cross this boundary. No paths, URLs or credentials.
export function documentText(bytes, format) {
  if (!['pdf', 'docx'].includes(format) || bytes.length > DOCUMENT_BYTES) throw failure('SOURCE_DOCUMENT_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./document-text-worker.mjs', import.meta.url), {
      workerData: { bytes, format }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 }, stdout: true, stderr: true,
    });
    // Parser diagnostics can contain document content; never relay them to logs.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(failure(error)); else resolve(value);
    };
    const timer = setTimeout(() => finish('SOURCE_DOCUMENT_TIMEOUT'), 15000);
    worker.once('message', result => finish(result.error, result.value));
    worker.once('error', () => finish('SOURCE_DOCUMENT_INVALID'));
    worker.once('exit', () => finish('SOURCE_DOCUMENT_INVALID'));
  });
}
