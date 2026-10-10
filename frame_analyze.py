#!/usr/bin/env python3
"""Describe lecture frames with a local vision model served by llama.cpp (Vulkan GPU).

Usage: python frame_analyze.py <frames-dir>

Reads <frames-dir>/captions.json (the frames kept by the Claude filter), runs each PNG through
llama-server, and writes <frames-dir>/descriptions.json:
    { "candidate_0003.png": { "description": "...", "text": "on-screen text/code" } }
Already-described frames are skipped, so reruns resume.

Backend: Lemonade Server if it answers at LEMONADE_URL (default http://localhost:13305/api/v1,
model LEMONADE_MODEL), otherwise a self-launched llama-server (setup-llama.ps1; VLM_MODEL /
VLM_MMPROJ / LLAMA_SERVER override its paths).
"""
import sys
import os
import json
import base64
import socket
import subprocess
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
LLAMA_SERVER = os.environ.get("LLAMA_SERVER") or os.path.join(
    ROOT, "tools", "llama.cpp", "build", "bin", "Release", "llama-server.exe")
LEMONADE_URL = (os.environ.get("LEMONADE_URL") or "http://localhost:13305/api/v1").rstrip("/")
LEMONADE_MODEL = os.environ.get("LEMONADE_MODEL") or "Qwen3-VL-8B-Instruct-GGUF"
MODELS_DIR = os.path.join(ROOT, "tools", "models")
MODEL = os.environ.get("VLM_MODEL") or os.path.join(MODELS_DIR, "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf")
MMPROJ = os.environ.get("VLM_MMPROJ") or os.path.join(MODELS_DIR, "mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf")

PROMPT = """This image is a frame from a computer science lecture video. Respond with JSON only, in this shape:
{"description": "<2-3 sentences: what the slide/diagram/code shows and its topic>", "text": "<on-screen text or code transcribed as exactly as you can, or empty string if none>"}"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http_json(url, payload=None, timeout=300):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def wait_ready(base, proc, timeout=300):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"llama-server exited early (code {proc.returncode})")
        try:
            if http_json(base + "/health", timeout=5).get("status") == "ok":
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("llama-server did not become ready in time")


def parse_reply(text):
    """Model should return JSON; fall back to the raw text as the description."""
    text = text.strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            obj = json.loads(text[start:end + 1])
            return {"description": str(obj.get("description", "")).strip(),
                    "text": str(obj.get("text", "")).strip()}
        except json.JSONDecodeError:
            pass
    return {"description": text, "text": ""}


def lemonade_up():
    try:
        http_json(LEMONADE_URL + "/models", timeout=3)
        return True
    except Exception:
        return False


def analyze(chat_url, model, image_path):
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    reply = http_json(chat_url, {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            {"type": "text", "text": PROMPT},
        ]}],
        "temperature": 0.1,
        "max_tokens": 500,
    })
    return parse_reply(reply["choices"][0]["message"]["content"])


def save(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def resolve_frames_dirs(arg):
    """Accept a frames folder, a video file, or a folder containing '-frames' folders."""
    arg = arg.strip().strip('"').rstrip("\\/")
    if os.path.isfile(arg):
        return [os.path.splitext(arg)[0] + "-frames"]
    if os.path.exists(os.path.join(arg, "captions.json")):
        return [arg]
    found = []
    for dirpath, dirnames, _files in os.walk(arg):
        for d in dirnames:
            if d.endswith("-frames") and os.path.exists(os.path.join(dirpath, d, "captions.json")):
                found.append(os.path.join(dirpath, d))
    return sorted(found) or [arg]


def main():
    if len(sys.argv) < 2:
        print("Usage: python frame_analyze.py <frames-dir | video | folder>", file=sys.stderr)
        sys.exit(1)
    dirs = resolve_frames_dirs(sys.argv[1])
    for frames_dir in dirs:
        if len(dirs) > 1:
            print(f"== {frames_dir}", file=sys.stderr)
        run(frames_dir)


def run(frames_dir):
    captions_path = os.path.join(frames_dir, "captions.json")
    if not os.path.exists(captions_path):
        print(f"No captions.json in {frames_dir}", file=sys.stderr)
        sys.exit(1)
    with open(captions_path, encoding="utf-8") as f:
        frames = [n for n in sorted(json.load(f)) if os.path.exists(os.path.join(frames_dir, n))]

    out_path = os.path.join(frames_dir, "descriptions.json")
    results = {}
    if os.path.exists(out_path):
        with open(out_path, encoding="utf-8") as f:
            results = json.load(f)
    todo = [n for n in frames if n not in results]
    if not todo:
        print(f"All {len(frames)} frame(s) already described.", file=sys.stderr)
        return

    def describe_all(chat_url, model):
        for i, name in enumerate(todo, 1):
            try:
                results[name] = analyze(chat_url, model, os.path.join(frames_dir, name))
            except Exception as err:
                print(f"  {name}: failed ({err})", file=sys.stderr)
                continue
            print(f"  [{i}/{len(todo)}] {name}", file=sys.stderr)
            if i % 5 == 0:
                save(out_path, results)

    if lemonade_up():
        print(f"Using Lemonade Server ({LEMONADE_MODEL}) for {len(todo)} frame(s)...", file=sys.stderr)
        try:
            describe_all(LEMONADE_URL + "/chat/completions", LEMONADE_MODEL)
        finally:
            save(out_path, results)
        return

    for p in (LLAMA_SERVER, MODEL, MMPROJ):
        if not os.path.exists(p):
            print(f"Lemonade Server is not running at {LEMONADE_URL} and {p} is missing "
                  f"-- start Lemonade or run setup-llama.ps1", file=sys.stderr)
            sys.exit(1)

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    print(f"Starting llama-server for {len(todo)} frame(s)...", file=sys.stderr)
    proc = subprocess.Popen(
        [LLAMA_SERVER, "-m", MODEL, "--mmproj", MMPROJ, "--port", str(port),
         "-ngl", "99", "-c", "4096", "--host", "127.0.0.1"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_ready(base, proc)
        describe_all(base + "/v1/chat/completions", "local")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        save(out_path, results)


if __name__ == "__main__":
    main()
