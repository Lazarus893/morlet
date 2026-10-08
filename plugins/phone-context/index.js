// phone-context：把手机（GUI 执行端）的连接状态作为一行结构化运行时上下文（UP 字段）贡献给每次模型请求。
// 文本只在状态变化时变化，对 KV cache 友好；探测在后台定时做，不占请求时间。
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const name = "phone-context";

const ADB = process.env.ADB || "adb";
const PROFILE_JSON = fileURLToPath(new URL("../../.runtime/phone.json", import.meta.url));
const HELPER_FILES = "/sdcard/Android/data/com.agent.helper/files";

function run(args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err && !stdout ? "" : String(stdout ?? "")));
  });
}

function deviceId(config) {
  if (config?.deviceId) return config.deviceId;
  if (process.env.PHONE_AGENT_DEVICE_ID) return process.env.PHONE_AGENT_DEVICE_ID;
  try { return JSON.parse(readFileSync(PROFILE_JSON, "utf8")).device_config?.device_id ?? ""; } catch { return ""; }
}

async function probe(id) {
  const devices = await run(["devices"]);
  const row = devices.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).find((p) => p[0] === id);
  if (!row) return { state: "absent" };
  if (row[1] !== "device") return { state: row[1] === "unauthorized" ? "unauthorized" : row[1] };
  const [win, rec] = await Promise.all([
    run(["-s", id, "shell", "dumpsys window | grep -m1 mDreamingLockscreen"], 8000),
    run(["-s", id, "shell", `cat ${HELPER_FILES}/record-status.json 2>/dev/null`], 5000),
  ]);
  let record = "unknown";
  try { const j = JSON.parse(rec); record = j.authorized ? (j.recording ? "recording" : "authorized") : "unauthorized"; } catch {}
  return { state: win.includes("mDreamingLockscreen=true") ? "locked" : "connected", record };
}

function render(id, s) {
  const base = `phone: state=${s.state} device=${id || "?"}`;
  if (s.state === "connected") return `${base} record=${s.record ?? "unknown"}`;
  return base;
}

export function apply(ctx, config = {}) {
  const id = deviceId(config);
  const intervalMs = Number(config.intervalMs ?? 8000);
  let current = { state: "unknown" };
  let text = render(id, current);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      current = await probe(id);
      text = render(id, current);
    } catch (e) {
      current = { state: "unknown" };
      text = render(id, current);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  ctx.on("dispose", () => clearInterval(timer));
  ctx.inject(["systemPrompt"], (scope) => {
    scope.systemPrompt.context({
      name: "phone:status",
      order: 9100,
      text: () => text,
    });
  });
}
