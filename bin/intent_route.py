#!/usr/bin/env python3
"""意图分流：把一条用户消息分成「移动端 / PC 端 / 混合 / 聊天 / 续接」，供小满在动手前参考。

两种用法：
  1. 作为 dsh 的 UserPromptSubmit 钩子：stdin 收 Claude Code 格式的 JSON（含 prompt、cwd），
     stdout 输出 {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}
  2. 手动：intent_route.py "消息文本" → 直接打印分流结果

模型和可选兼容接口由本机 INTENT_MODEL/INTENT_API_URL 配置；自定义接口只使用 INTENT_API_KEY。
失败即放行（不注入任何内容），绝不阻塞消息。
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from runtime_paths import DSH_HOME, WORKSPACE
CRED = DSH_HOME / ".credentials.yaml"
DEFAULT_API = "https://api.deepseek.com/chat/completions"
API = os.environ.get("INTENT_API_URL") or DEFAULT_API
MODEL = os.environ.get("INTENT_MODEL", "deepseek-flash")
TIMEOUT = 12

SYSTEM = """你是一个意图分流器，服务于「小满」——运行在用户的电脑上、通过微信对话的私人生活助理。
小满有两只手：
- PC 端（电脑）：联网搜索、打开网页、读写它工作区里的文件、电脑上的提醒事项/备忘录/日历技能、整理和写作。
- 移动端（用户配置的 Android 或 iPhone）：在国内 App 里操作——美团、大众点评、小红书、抖音、微信、淘宝、闲鱼、京东、支付宝、菜鸟、高德地图、滴滴出行、飞猪、携程、淘票票。只查不付、不下单、不发消息。
分流原则：
1. 能在网页/联网工具拿到的 → pc。典型：天气、新闻、常识、公开的营业时间/价格/路线概览、公众号文章。
2. 只有 App 里有的 → mobile。典型：我的订单/物流/账单/收藏/购物车/聊天记录、需要定位或登录态的「附近/最近/能不能送/配送费」、网页版阉割的小红书笔记/闲鱼/抖音/点评完整评价。
3. 两边都要 → hybrid：先 PC 查公开信息（候选、常识、地址），再手机取只有 App 有的部分，最后合并。
4. 纯聊天、情绪、问小满自己、记一句话 → chat。
5. 是对上一轮的续接（继续、好了、批准、确认、不要、换一家、第二个）→ continue。
只输出 JSON，字段值都要短：reason ≤ 40 字，pc_task ≤ 80 字，mobile_task ≤ 120 字（写成给手机执行器的一句话：打开X，做什么，用 finish 汇报什么，不要做什么），merge ≤ 60 字。
{"route":"pc|mobile|hybrid|chat|continue","confidence":0.0-1.0,"reason":"…","pc_task":"没有则空串","mobile_task":"没有则空串","merge":"没有则空串","needs_location":true/false}"""


def load_key() -> str | None:
    if os.environ.get("INTENT_API_KEY"):
        return os.environ["INTENT_API_KEY"]
    if API != DEFAULT_API:
        return None  # Never send an existing provider's key to a different endpoint.
    if os.environ.get("DEEPSEEK_API_KEY"):
        return os.environ["DEEPSEEK_API_KEY"]
    try:
        m = re.search(r"^\s*DEEPSEEK_API_KEY:\s*['\"]?([^'\"\n]+)", CRED.read_text(), re.M)
        return m.group(1).strip() if m else None
    except OSError:
        return None


def quick_route(text: str) -> dict | None:
    t = text.strip()
    if not t or t.startswith("/"):
        return {"route": "continue", "confidence": 1.0, "reason": "命令或空消息"}
    if len(t) <= 8 and re.match(r"^(继续|好了|好的|可以|批准|确认|不要|算了|是|不是|嗯|对|ok|OK|第[一二三四五]个|换一家|换一个|再试试|谢谢|谢了)[。！!～~]*$", t):
        return {"route": "continue", "confidence": 0.95, "reason": "对上一轮的续接"}
    return None


def classify(text: str) -> dict | None:
    if os.environ.get("INTENT_ENABLED", "true").lower() in {"false", "0", "off"}:
        return None
    endpoint = urlparse(API)
    if (endpoint.scheme != "https" and not (endpoint.scheme == "http" and endpoint.hostname in {"localhost", "127.0.0.1", "::1"})) or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise ValueError("Invalid intent API endpoint")
    key = load_key()
    if not key:
        return None
    body = {
        "model": MODEL,
        "temperature": 0,
        "max_tokens": 900,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text[:1500]}],
    }
    req = urllib.request.Request(API, data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    # An authorization-bearing request must not follow redirects to another host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    with urllib.request.build_opener(NoRedirect).open(req, timeout=TIMEOUT) as resp:
        data = json.loads(resp.read())
    content = data["choices"][0]["message"]["content"]
    try:
        out = json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r'"route"\s*:\s*"(pc|mobile|hybrid|chat|continue)"', content)
        if not m:
            raise
        out = {"route": m.group(1), "confidence": 0.5, "reason": "模型输出被截断，只取到 route"}
        for key in ("pc_task", "mobile_task", "merge"):
            mm = re.search(rf'"{key}"\s*:\s*"([^"]{{0,200}})', content)
            if mm:
                out[key] = mm.group(1)
    if out.get("route") not in ("pc", "mobile", "hybrid", "chat", "continue"):
        return None
    return out


def render(r: dict) -> str:
    route = r["route"]
    names = {"pc": "PC 端（网页/本机工具）", "mobile": "移动端（手机 App）", "hybrid": "混合（先 PC 后手机，再合并）", "chat": "聊天，不用动手", "continue": "续接上一轮"}
    lines = [f"[意图分流] route={route}  {names.get(route, route)}  置信度 {r.get('confidence', '?')}"]
    if r.get("reason"):
        lines.append(f"- 依据：{r['reason']}")
    if route in ("pc", "hybrid") and r.get("pc_task"):
        lines.append(f"- PC 端：{r['pc_task']}")
    if route in ("mobile", "hybrid") and r.get("mobile_task"):
        lines.append(f"- 手机端（phone 技能，任务可直接用）：{r['mobile_task']}")
    if route == "hybrid" and r.get("merge"):
        lines.append(f"- 合并：{r['merge']}")
    if route in ("mobile", "hybrid"):
        lines.append("- 动手前看运行时上下文里的 phone: state=… 那一行：不是 connected 就先让用户接上/解锁/授权，别跑。")
    if r.get("needs_location"):
        lines.append("- 涉及位置：先确认用户现在在哪，任务里写具体地名。")
    if route in ("mobile", "hybrid"):
        lines.append("- 共享：手机侧产物会自动拉到 shared/from-phone/，要给手机用的文件放 shared/to-phone/ 再 phone_task.py push。")
    lines.append("- 分流只是建议，置信度低或明显不对就按你的判断来。")
    return "\n".join(lines)


def main() -> None:
    if len(sys.argv) > 1:
        text = " ".join(sys.argv[1:])
        payload = {}
    else:
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError:
            payload = {}
        text = payload.get("prompt") or ""
        if isinstance(text, list):
            text = " ".join(b.get("text", "") for b in text if isinstance(b, dict))
    result = quick_route(text)
    started = time.time()
    if result is None:
        try:
            result = classify(text)
        except Exception as e:  # noqa: BLE001
            result = None
            err = f"{type(e).__name__}: {e}"
        else:
            err = None
    else:
        err = None
    cwd = payload.get("cwd") or str(WORKSPACE)
    try:
        logp = Path(cwd) / "shared" / "intent-log.jsonl"
        logp.parent.mkdir(parents=True, exist_ok=True)
        with logp.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "text": text[:200], "result": result, "error": err, "ms": int((time.time() - started) * 1000)}, ensure_ascii=False) + "\n")
    except OSError:
        pass
    if len(sys.argv) > 1:
        print(render(result) if result else f"分流失败：{err}")
        return
    if not result or result["route"] == "continue":
        return  # 不注入
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": render(result)}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
