#!/usr/bin/env python3
"""Direct OpenAI-compatible gateway checks. Reads AI_* from the repository .env; never prints the key."""
import json, os, re, sys, time
import requests

CFG = os.path.expanduser("~/ayakaleaf-toolkit/config")
def envfile(p):
    d = {}
    for line in open(p):
        m = re.match(r'^([A-Z_]+)=(.*)$', line.strip())
        if m: d[m.group(1)] = m.group(2).strip().strip('"')
    return d
env = envfile(os.path.join(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."), ".env"))
BASE, MODEL, KEY = env["AI_BASE_URL"].rstrip("/"), env["AI_MODEL"], env.get("AI_API_KEY", "")
if not KEY: sys.exit("AI_API_KEY is empty in config/ai.env")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
results = {}

def rec(name, ok, detail):
    results[name] = ok
    print(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")

TOOLS = [{"type": "function", "function": {"name": "suggestLineChange",
    "description": "Propose replacing one line of a LaTeX file.",
    "parameters": {"type": "object", "properties": {
        "line": {"type": "integer"}, "newContent": {"type": "string"}, "explanation": {"type": "string"}},
        "required": ["line", "newContent", "explanation"]}}}]
TOOL_MSG = [{"role": "user", "content": "Line 5 of main.tex is `\\begin{itemiz}` and LaTeX reports 'Environment itemiz undefined'. Call suggestLineChange to fix it."}]

def stream(body):
    r = requests.post(f"{BASE}/chat/completions", headers=H, json={**body, "stream": True,
                      "stream_options": {"include_usage": True}}, stream=True, timeout=180)
    if r.status_code != 200: return r.status_code, None
    chunks, text, reasoning, tcalls, usage, first = 0, "", "", {}, None, None
    t0 = time.time()
    for raw in r.iter_lines():
        if not raw.startswith(b"data:"): continue
        data = raw[5:].strip()
        if data == b"[DONE]": break
        j = json.loads(data); chunks += 1
        if first is None: first = time.time() - t0
        if j.get("usage"): usage = j["usage"]
        for ch in j.get("choices", []):
            d = ch.get("delta", {})
            text += d.get("content") or ""
            reasoning += d.get("reasoning_content") or d.get("reasoning") or ""
            for tc in d.get("tool_calls") or []:
                e = tcalls.setdefault(tc.get("index", 0), {"name": "", "args": ""})
                f = tc.get("function", {})
                e["name"] += f.get("name") or ""; e["args"] += f.get("arguments") or ""
    return 200, dict(chunks=chunks, text=text, reasoning=reasoning, tcalls=tcalls, usage=usage, ttfb=first)

# 1. auth / models
r = requests.get(f"{BASE}/models", headers=H, timeout=30)
ids = [m["id"] for m in r.json().get("data", [])] if r.ok else []
rec("auth+models", r.ok and MODEL in ids, f"HTTP {r.status_code}, {len(ids)} models, configured model listed={MODEL in ids}")
r = requests.get(f"{BASE}/models", headers={"Authorization": "Bearer invalid-key-test"}, timeout=30)
rec("rejects-bad-key", r.status_code in (401, 403), f"HTTP {r.status_code}")

# 2. non-streaming chat
t = time.time()
r = requests.post(f"{BASE}/chat/completions", headers=H, timeout=180, json={"model": MODEL, "max_tokens": 400,
    "messages": [{"role": "user", "content": "Reply with exactly: GATEWAY-OK"}]})
j = r.json() if r.ok else {}
msg = (j.get("choices") or [{}])[0].get("message", {})
rec("chat", r.ok and "GATEWAY-OK" in (msg.get("content") or ""),
    f"HTTP {r.status_code} {time.time()-t:.1f}s content={(msg.get('content') or '')[:60]!r} reasoning_field={'reasoning_content' in msg or 'reasoning' in msg} usage={j.get('usage')}")

# 3. streaming chat
code, s = stream({"model": MODEL, "max_tokens": 400, "messages": [{"role": "user", "content": "Count from 1 to 5 separated by spaces."}]})
rec("stream", code == 200 and s["chunks"] > 1 and "5" in s["text"],
    f"HTTP {code} chunks={s and s['chunks']} ttfb={s and round(s['ttfb'] or 0,2)}s text={(s or {}).get('text','')[:40]!r} usage={(s or {}).get('usage')}")

# 4. tool calling (non-stream)
r = requests.post(f"{BASE}/chat/completions", headers=H, timeout=180, json={"model": MODEL, "max_tokens": 1500,
    "messages": TOOL_MSG, "tools": TOOLS, "tool_choice": "auto"})
j = r.json() if r.ok else {"error": r.text[:200]}
tc = ((j.get("choices") or [{}])[0].get("message") or {}).get("tool_calls") or []
ok = False
if tc:
    try: a = json.loads(tc[0]["function"]["arguments"]); ok = tc[0]["function"]["name"] == "suggestLineChange" and "itemize" in a.get("newContent", "")
    except Exception as e: a = f"unparseable: {e}"
rec("tools", ok, f"HTTP {r.status_code} finish={(j.get('choices') or [{}])[0].get('finish_reason')} calls={[(c['function']['name'], c['function']['arguments'][:80]) for c in tc]}")

# 5. streaming tool calling (what the AI SDK actually uses)
code, s = stream({"model": MODEL, "max_tokens": 1500, "messages": TOOL_MSG, "tools": TOOLS, "tool_choice": "auto"})
ok = False
if s and s["tcalls"]:
    c = s["tcalls"][min(s["tcalls"])]
    try: ok = c["name"] == "suggestLineChange" and "itemize" in json.loads(c["args"]).get("newContent", "")
    except Exception: pass
rec("stream+tools", ok, f"HTTP {code} calls={[(v['name'], v['args'][:80]) for v in (s or {}).get('tcalls', {}).values()]} text={(s or {}).get('text','')[:60]!r}")

# 6. multi-turn tool result round-trip
if results.get("tools"):
    call = tc[0]
    msgs = TOOL_MSG + [{"role": "assistant", "content": None, "tool_calls": [call]},
                       {"role": "tool", "tool_call_id": call["id"], "content": json.dumps({"applied": True})}]
    r = requests.post(f"{BASE}/chat/completions", headers=H, timeout=180, json={"model": MODEL, "max_tokens": 800, "messages": msgs, "tools": TOOLS})
    m = (r.json().get("choices") or [{}])[0].get("message", {}) if r.ok else {}
    rec("tool-result-roundtrip", r.ok and bool(m.get("content")), f"HTTP {r.status_code} reply={(m.get('content') or '')[:80]!r}")

print("\nSUMMARY", json.dumps(results))
