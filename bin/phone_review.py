#!/usr/bin/env python3
"""复盘一次手机任务：把 steps.jsonl + 截图 + 录屏抽帧整理成 review.md，并指出浪费的步骤。

用法：phone_review.py <task-id|last> [--log-root DIR]
产出：phone-logs/<task-id>/review.md、frames/step_NNN.jpg、review_sheet.jpg（拼图，一眼看完整个过程）
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from runtime_paths import WORKSPACE

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"


def log_root_default() -> Path:
    env = os.environ.get("PHONE_LOG_ROOT")
    return Path(env) if env else WORKSPACE / "phone-logs"


def resolve(root: Path, ref: str) -> Path:
    if ref == "last":
        dirs = sorted((d for d in root.iterdir() if d.is_dir() and (d / "steps.jsonl").exists()), key=lambda d: d.stat().st_mtime)
        if not dirs:
            print(f"{root} 下没有任务记录"); sys.exit(3)
        return dirs[-1]
    d = root / ref
    if not (d / "steps.jsonl").exists():
        print(f"找不到任务 {ref}"); sys.exit(3)
    return d


def parse_ts(s: str) -> float:
    return datetime.fromisoformat(s).timestamp()


def action_kind(a) -> str:
    if not isinstance(a, dict):
        return "?"
    return str(a.get("action") or a.get("_metadata") or "?")


def describe(a) -> str:
    if not isinstance(a, dict):
        return str(a)[:80]
    kind = action_kind(a)
    bits = [kind]
    for k in ("app", "text", "message", "element", "duration"):
        if a.get(k) not in (None, ""):
            v = a[k]
            if isinstance(v, str) and len(v) > 40:
                v = v[:40] + "…"
            bits.append(f"{k}={v}")
    return " ".join(bits)


def extract_frame(video: Path, offset: float, out: Path) -> bool:
    if offset < 0:
        offset = 0
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [FFMPEG, "-y", "-loglevel", "error", "-ss", f"{offset:.2f}", "-i", str(video), "-frames:v", "1", "-vf", "scale=270:-1", str(out)]
    try:
        subprocess.run(cmd, check=True, timeout=30, capture_output=True)
        return out.exists() and out.stat().st_size > 0
    except Exception:  # noqa: BLE001
        return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("task_id")
    ap.add_argument("--log-root", default=None)
    args = ap.parse_args()
    root = Path(args.log_root) if args.log_root else log_root_default()
    d = resolve(root, args.task_id)

    state = json.loads((d / "state.json").read_text()) if (d / "state.json").exists() else {}
    steps = [json.loads(l) for l in (d / "steps.jsonl").read_text().splitlines() if l.strip()]
    segments = []
    if (d / "recordings/index.json").exists():
        try:
            segments = json.loads((d / "recordings/index.json").read_text())
        except json.JSONDecodeError:
            segments = []
    segments = [s for s in segments if (d / "recordings" / s["file"]).exists()]

    # ── 抽帧：每一步动作「执行后」的画面 ≈ 下一步开始前；取本步时间戳 +1.5s
    frames: dict[int, Path] = {}
    for st in steps:
        ts = parse_ts(st["ts"]) + 1.5
        for seg in segments:
            if seg["start"] <= ts <= seg.get("end", ts):
                out = d / "frames" / f"step_{st['step']:03d}.jpg"
                if extract_frame(d / "recordings" / seg["file"], ts - seg["start"], out):
                    frames[st["step"]] = out
                break
    # 没录像就退回到现有截图
    shots = sorted((d / "screenshots").glob("*.png")) if (d / "screenshots").exists() else []

    # ── 浪费的步骤
    issues: list[str] = []
    kinds = [action_kind(s.get("action")) for s in steps]
    cnt = Counter(kinds)
    if cnt.get("Wait", 0) >= 3:
        issues.append(f"Wait 用了 {cnt['Wait']} 次：App 加载慢或开屏广告没处理，考虑在任务里写「如果有广告/弹窗先关掉」，或在经验里补这个 App 的开屏处理。")
    if cnt.get("Back", 0) >= 2:
        issues.append(f"Back 回退 {cnt['Back']} 次：进错页面了，看对应帧确认是入口写错还是误触。")
    run = 1
    for i in range(1, len(steps)):
        if json.dumps(steps[i].get("action"), sort_keys=True, ensure_ascii=False) == json.dumps(steps[i-1].get("action"), sort_keys=True, ensure_ascii=False):
            run += 1
            if run == 3:
                issues.append(f"第 {steps[i-2]['step']}–{steps[i]['step']} 步连续重复同一动作：{describe(steps[i]['action'])}，页面没变化，执行器卡住了。")
        else:
            run = 1
    for s in steps:
        if not s.get("success", True):
            issues.append(f"第 {s['step']} 步执行失败：{s.get('message') or describe(s.get('action'))}")
    if state.get("pending_confirmation"):
        issues.append(f"停在敏感操作：{state['pending_confirmation']}")
    if state.get("pending_takeover"):
        issues.append(f"停在接管：{state['pending_takeover']}")
    if state.get("status") in ("max_steps_reached", "timeout", "error"):
        issues.append(f"任务没做完（{state['status']}）：{state.get('final_message') or ''}")
    launched = [a.get("app") for a in (s.get("action") for s in steps) if isinstance(a, dict) and a.get("action") == "Launch"]

    # ── review.md
    lines = [f"# 复盘 {d.name}", ""]
    lines.append(f"- 任务：{state.get('task')}")
    lines.append(f"- App：{'、'.join(dict.fromkeys(launched)) or '（没有 Launch 记录）'}")
    lines.append(f"- 状态：{state.get('status')}  步数：{len(steps)}  耗时：{state.get('elapsed', '?')} 秒  录屏：{len(segments)} 段")
    if state.get("final_message"):
        lines.append("- 手机端汇报：" + " ".join(str(state["final_message"]).split())[:300])
    lines += ["", "## 问题清单", ""]
    lines += [f"- {x}" for x in issues] or ["- 没有发现明显浪费。"]
    lines += ["", "## 时间线", "", "| 步 | 动作 | 想法（截断） | 画面 |", "|---|---|---|---|"]
    for s in steps:
        img = frames.get(s["step"])
        if img is None:
            cand = [p for p in shots if p.name.startswith(f"{s['step']:03d}_")]
            img = cand[0] if cand else None
        rel = img.relative_to(d) if img else ""
        lines.append(f"| {s['step']} | {describe(s.get('action'))} | {(s.get('thinking') or '')[:60]} | {rel} |")
    lines += ["", "## 复盘后要写的两条", "",
              "1. 任务描述怎么改更顺（写到 skills/phone/references/apps/<App>.md 的「任务描述模板」或「待实测校准」，带日期）。",
              "2. 执行器层的 UI 经验（弹窗、入口、何时 Wait，写到 auto-phone/phone_agent/experiences/<App>.md，短句）。",
              ""]
    (d / "review.md").write_text("\n".join(lines), encoding="utf-8")

    # ── 拼图
    sheet = None
    imgs = [frames[k] for k in sorted(frames)] or shots
    if imgs and FFMPEG and os.path.exists(FFMPEG):
        n = len(imgs)
        cols = 6 if n > 12 else 4
        rows = (n + cols - 1) // cols
        inputs = []
        for p in imgs:
            inputs += ["-i", str(p)]
        fc = "".join(f"[{i}:v]scale=200:-1,pad=200:444:0:0:black[v{i}];" for i in range(n)) + "".join(f"[v{i}]" for i in range(n)) + f"xstack=inputs={n}:layout={'|'.join(f'{(i%cols)*200}_{(i//cols)*444}' for i in range(n))}[out]" if n > 1 else "[0:v]scale=200:-1[out]"
        sheet = d / "review_sheet.jpg"
        try:
            subprocess.run([FFMPEG, "-y", "-loglevel", "error", *inputs, "-filter_complex", fc, "-map", "[out]", "-q:v", "4", str(sheet)], check=True, timeout=60, capture_output=True)
        except Exception:  # noqa: BLE001
            sheet = None

    print(f"复盘写好了：{d / 'review.md'}")
    print(f"问题 {len(issues)} 条；抽帧 {len(frames)} 张" + (f"；拼图 {sheet}" if sheet else ""))
    for x in issues:
        print(f"- {x}")


if __name__ == "__main__":
    main()
