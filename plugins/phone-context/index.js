import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'phone-context';
const entry = fileURLToPath(new URL('../../scripts/onboard.py', import.meta.url));

export function apply(ctx, config = {}) {
  let text = 'phone: state=unknown';
  let busy = false;
  let disposed = false;
  const tick = () => {
    if (busy || disposed) return;
    busy = true;
    execFile(process.env.PA_PYTHON || 'python3', [entry, 'device-status', '--json'],
      { timeout: 15000, maxBuffer: 65536 }, (error, stdout) => {
        busy = false;
        if (disposed) return;
        try {
          if (error) throw error;
          const state = JSON.parse(stdout);
          text = `phone: state=${state.state} provider=${state.provider} device=${state.id || '?'} detail=${state.detail}`;
        } catch { text = 'phone: state=unknown detail=设备状态探测失败'; }
      });
  };
  tick();
  const timer = setInterval(tick, Math.max(1000, Number(config.intervalMs || 8000)));
  timer.unref?.();
  ctx.on('dispose', () => { disposed = true; clearInterval(timer); });
  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.context({ name: 'phone:status', order: 9100, text: () => text });
  });
}
