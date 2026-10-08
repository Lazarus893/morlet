// 诊断用：把 cordis 内存日志缓冲写到文件，便于排查插件报错。
import { appendFileSync } from "node:fs";
export const name = "log-to-file";
export function apply(ctx) {
  const file = process.env.DSH_LOG_FILE ?? "/tmp/dsh-wx-life-cordis.log";
  const fmt = (v) => (v instanceof Error ? (v.stack ?? v.message) : typeof v === "string" ? v : JSON.stringify(v));
  ctx.logger.exporter({
    colors: 0,
    export: (m) => {
      try {
        const line = `${new Date().toISOString()} [${m.type ?? m.level ?? "?"}] ${m.name ?? ""}: ${fmt(m.content ?? m.message ?? m.args ?? m)}\n`;
        appendFileSync(file, line);
      } catch {}
    },
  });
  for (const m of ctx.logger.buffer ?? []) {
    try { appendFileSync(file, `${new Date().toISOString()} [buffered] ${m.name ?? ""}: ${fmt(m.content ?? m.message ?? m)}\n`); } catch {}
  }
}
