#!/usr/bin/env python3
"""
Llama Server Manager — WebUI backend
Manages llama-server (llama.cpp) process, exposes system metrics,
handles service installation, and proxies chat completions.
"""

import os
import sys
import json
import time
import signal
import subprocess
import threading
import shutil
import platform
import re
from pathlib import Path
from datetime import datetime

import psutil
import requests
from flask import Flask, render_template, request, jsonify, Response
from flask_socketio import SocketIO, emit

# ── Constants ────────────────────────────────────────────────────────────────

APP_DIR = Path(__file__).parent.resolve()
CONFIG_FILE = APP_DIR / "config.json"
DEFAULT_MODELS_DIR = "/opt/models"

# ── Flask setup ──────────────────────────────────────────────────────────────

app = Flask(__name__)
app.config["SECRET_KEY"] = os.urandom(24).hex()
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ── Server state ─────────────────────────────────────────────────────────────

class State:
    process: subprocess.Popen | None = None
    pid: int | None = None
    running: bool = False
    start_time: float | None = None
    log_buffer: list[str] = []
    MAX_LOG = 2000
    lock = threading.Lock()

S = State()

# ── Configuration ────────────────────────────────────────────────────────────

DEFAULTS = {
    "llama_server_path": "",
    "models_dir": DEFAULT_MODELS_DIR,
    "selected_model": "",
    "host": "127.0.0.1",
    "port": 8080,
    "ctx_size": 4096,
    "threads": max(1, (os.cpu_count() or 2) - 1),
    "threads_batch": os.cpu_count() or 2,
    "n_gpu_layers": 0,
    "main_gpu": 0,
    "batch_size": 2048,
    "ubatch_size": 512,
    "flash_attn": False,
    "cache_type_k": "f16",
    "cache_type_v": "f16",
    "mlock": False,
    "no_mmap": False,
    "parallel": 1,
    "cont_batching": True,
    "embedding": False,
    "numa": "disabled",
    "rope_freq_base": 0,
    "rope_freq_scale": 0.0,
    "verbose": True,
    "extra_args": "",
}


def cfg_load() -> dict:
    c = DEFAULTS.copy()
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                c.update(json.load(f))
        except Exception:
            pass
    if not c["llama_server_path"]:
        c["llama_server_path"] = _find_binary()
    return c


def cfg_save(c: dict):
    with open(CONFIG_FILE, "w") as f:
        json.dump(c, f, indent=2)


def _find_binary() -> str:
    for p in ["/usr/local/bin/llama-server", "/usr/bin/llama-server"]:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    w = shutil.which("llama-server")
    return w or ""


# ── Model discovery ──────────────────────────────────────────────────────────

def discover_models(models_dir: str) -> list[dict]:
    out = []
    md = Path(models_dir)
    if not md.exists():
        return out
    for ext in ("*.gguf", "*.bin"):
        for f in md.rglob(ext):
            try:
                st = f.stat()
                out.append({
                    "path": str(f),
                    "name": f.name,
                    "rel": str(f.relative_to(md)),
                    "size": st.st_size,
                    "size_h": _fmt_sz(st.st_size),
                    "mtime": datetime.fromtimestamp(st.st_mtime).strftime(
                        "%Y-%m-%d %H:%M"
                    ),
                })
            except OSError:
                pass
    out.sort(key=lambda x: x["name"].lower())
    return out


def _fmt_sz(b: int) -> str:
    for u in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024:
            return f"{b:.1f} {u}"
        b /= 1024
    return f"{b:.1f} PB"


# ── Command builder ──────────────────────────────────────────────────────────

def build_cmd(c: dict) -> list[str]:
    cmd = [c["llama_server_path"]]
    if c.get("selected_model"):
        cmd += ["-m", c["selected_model"]]
    cmd += ["--host", c.get("host", "127.0.0.1")]
    cmd += ["--port", str(c.get("port", 8080))]
    cmd += ["-c", str(c.get("ctx_size", 4096))]
    cmd += ["-t", str(c.get("threads", 4))]
    cmd += ["-tb", str(c.get("threads_batch", 4))]
    cmd += ["-ngl", str(c.get("n_gpu_layers", 0))]
    cmd += ["-b", str(c.get("batch_size", 2048))]
    cmd += ["-ub", str(c.get("ubatch_size", 512))]
    cmd += ["-np", str(c.get("parallel", 1))]
    if c.get("main_gpu", 0) > 0:
        cmd += ["-mg", str(c["main_gpu"])]
    if c.get("flash_attn"):
        cmd.append("-fa")
    cmd += ["--cache-type-k", c.get("cache_type_k", "f16")]
    cmd += ["--cache-type-v", c.get("cache_type_v", "f16")]
    if c.get("mlock"):
        cmd.append("--mlock")
    if c.get("no_mmap"):
        cmd.append("--no-mmap")
    if c.get("cont_batching"):
        cmd.append("-cb")
    if c.get("embedding"):
        cmd.append("--embedding")
    n = c.get("numa", "disabled")
    if n and n != "disabled":
        cmd += ["--numa", n]
    if c.get("rope_freq_base", 0) > 0:
        cmd += ["--rope-freq-base", str(c["rope_freq_base"])]
    if c.get("rope_freq_scale", 0) > 0:
        cmd += ["--rope-freq-scale", str(c["rope_freq_scale"])]
    if c.get("verbose"):
        cmd.append("--verbose")
    extra = c.get("extra_args", "").strip()
    if extra:
        cmd += extra.split()
    return cmd


# ── Process management ───────────────────────────────────────────────────────

def server_start(c: dict) -> tuple[bool, str]:
    with S.lock:
        if S.process and S.process.poll() is None:
            return False, "Server already running"
    if not c.get("llama_server_path"):
        return False, "llama-server binary path not set"
    if not os.path.isfile(c.get("llama_server_path", "")):
        return False, f"Binary not found: {c['llama_server_path']}"
    if not c.get("selected_model"):
        return False, "No model selected"
    if not os.path.isfile(c["selected_model"]):
        return False, f"Model not found: {c['selected_model']}"

    cmd = build_cmd(c)
    with S.lock:
        S.log_buffer.clear()
        S.log_buffer.append(
            f"[{datetime.now().strftime('%H:%M:%S')}] Starting: {' '.join(cmd)}\n"
        )
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            universal_newlines=True,
            preexec_fn=os.setsid,
        )
        with S.lock:
            S.process = proc
            S.pid = proc.pid
            S.running = True
            S.start_time = time.time()
        threading.Thread(target=_read_stdout, daemon=True).start()
        cfg_save(c)
        return True, f"Started PID {proc.pid}"
    except Exception as e:
        return False, str(e)


def server_stop() -> tuple[bool, str]:
    with S.lock:
        proc = S.process
    if not proc:
        return True, "Server not running"
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        proc.wait(timeout=5)
    except Exception:
        pass
    with S.lock:
        S.process = None
        S.pid = None
        S.running = False
        S.start_time = None
    return True, "Stopped"


def _read_stdout():
    try:
        proc = S.process
        if not proc or not proc.stdout:
            return
        for line in proc.stdout:
            with S.lock:
                S.log_buffer.append(line)
                if len(S.log_buffer) > S.MAX_LOG:
                    S.log_buffer = S.log_buffer[-S.MAX_LOG:]
            socketio.emit("log_line", {"line": line})
    except Exception:
        pass
    finally:
        with S.lock:
            S.running = False
            S.pid = None
        socketio.emit("server_stopped", {})


def _is_running() -> bool:
    with S.lock:
        return S.process is not None and S.process.poll() is None


# ── Metrics collectors ───────────────────────────────────────────────────────

def get_cpu() -> dict:
    pct = psutil.cpu_percent(percpu=True)
    freq = psutil.cpu_freq()
    temps = []
    try:
        for chip, entries in psutil.sensors_temperatures().items():
            for e in entries:
                temps.append(
                    {
                        "label": f"{chip}/{e.label or 'temp'}",
                        "current": e.current,
                        "high": e.high,
                        "critical": e.critical,
                    }
                )
    except Exception:
        pass
    return {
        "percent": pct,
        "avg": round(sum(pct) / len(pct), 1) if pct else 0,
        "count": psutil.cpu_count(),
        "phys": psutil.cpu_count(logical=False),
        "freq": round(freq.current, 0) if freq else 0,
        "freq_max": round(freq.max, 0) if freq and freq.max else 0,
        "temps": temps,
    }


def get_mem() -> dict:
    m = psutil.virtual_memory()
    sw = psutil.swap_memory()
    return {
        "total": m.total,
        "used": m.used,
        "available": m.available,
        "pct": m.percent,
        "swap_total": sw.total,
        "swap_used": sw.used,
        "swap_pct": sw.percent,
    }


def get_gpus() -> list[dict]:
    gpus = []
    # NVIDIA
    try:
        r = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,temperature.gpu,utilization.gpu,"
                "memory.used,memory.total,power.draw,power.limit,"
                "fan.speed,clocks.current.graphics,clocks.current.memory",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
        )
        if r.returncode == 0:
            for line in r.stdout.strip().splitlines():
                p = [x.strip() for x in line.split(",")]
                if len(p) < 8:
                    continue

                def _f(v):
                    try:
                        return float(v)
                    except (ValueError, TypeError):
                        return None

                gpus.append(
                    {
                        "type": "NVIDIA",
                        "idx": int(p[0]),
                        "name": p[1],
                        "temp": _f(p[2]),
                        "util": _f(p[3]),
                        "mem_used": _f(p[4]),
                        "mem_total": _f(p[5]),
                        "power": _f(p[6]),
                        "power_limit": _f(p[7]),
                        "fan": _f(p[8]) if len(p) > 8 else None,
                        "clk_gpu": _f(p[9]) if len(p) > 9 else None,
                        "clk_mem": _f(p[10]) if len(p) > 10 else None,
                    }
                )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    # AMD
    if not gpus:
        try:
            r = subprocess.run(
                ["rocm-smi", "--showtemp", "--showuse", "--showmeminfo",
                 "vram", "--showpower", "--csv"],
                capture_output=True, text=True, timeout=3,
            )
            if r.returncode == 0:
                lines = r.stdout.strip().splitlines()
                if len(lines) > 1:
                    hdr = [h.strip().lower() for h in lines[0].split(",")]
                    for row in lines[1:]:
                        vals = [v.strip() for v in row.split(",")]
                        d = dict(zip(hdr, vals))

                        def _g(k):
                            for key, val in d.items():
                                if k in key:
                                    try:
                                        return float(val)
                                    except (ValueError, TypeError):
                                        return None
                            return None

                        gpus.append(
                            {
                                "type": "AMD",
                                "idx": len(gpus),
                                "name": d.get("card series", "AMD GPU"),
                                "temp": _g("temperature"),
                                "util": _g("gpu use"),
                                "mem_used": _g("vram used") or _g("used"),
                                "mem_total": _g("vram total") or _g("total"),
                                "power": _g("power"),
                                "power_limit": None,
                                "fan": _g("fan"),
                                "clk_gpu": None,
                                "clk_mem": None,
                            }
                        )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    return gpus


def get_llama_health(c: dict):
    h = c.get("host", "127.0.0.1")
    if h == "0.0.0.0":
        h = "127.0.0.1"
    try:
        r = requests.get(f"http://{h}:{c['port']}/health", timeout=2)
        return r.json()
    except Exception:
        return None


def get_llama_metrics_raw(c: dict):
    h = c.get("host", "127.0.0.1")
    if h == "0.0.0.0":
        h = "127.0.0.1"
    try:
        r = requests.get(f"http://{h}:{c['port']}/metrics", timeout=2)
        out = {}
        for line in r.text.splitlines():
            if line and not line.startswith("#"):
                parts = line.split()
                if len(parts) >= 2:
                    try:
                        out[parts[0]] = float(parts[1])
                    except ValueError:
                        pass
        return out
    except Exception:
        return None


def get_llama_slots(c: dict):
    h = c.get("host", "127.0.0.1")
    if h == "0.0.0.0":
        h = "127.0.0.1"
    try:
        r = requests.get(f"http://{h}:{c['port']}/slots", timeout=2)
        return r.json()
    except Exception:
        return None


# ── Systemd service helpers ──────────────────────────────────────────────────

LLAMA_SVC = "llama-server"
MANAGER_SVC = "llama-manager"

_SVC_LLAMA = """[Unit]
Description=Llama Server (llama.cpp)
After=network.target

[Service]
Type=simple
User={user}
WorkingDirectory={wd}
ExecStart={cmd}
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
"""

_SVC_MANAGER = """[Unit]
Description=Llama Server Manager WebUI
After=network.target

[Service]
Type=simple
User={user}
WorkingDirectory={wd}
ExecStart={py} {app} --host 0.0.0.0 --port {port}
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
"""


def svc_status(name: str) -> dict:
    try:
        a = subprocess.run(
            ["systemctl", "is-active", name], capture_output=True, text=True
        ).stdout.strip()
        e = subprocess.run(
            ["systemctl", "is-enabled", name], capture_output=True, text=True
        ).stdout.strip()
        p = subprocess.run(
            ["systemctl", "show", name, "--property=MainPID,ActiveEnterTimestamp"],
            capture_output=True, text=True,
        )
        props = {}
        for line in p.stdout.strip().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                props[k] = v
        return {
            "active": a,
            "enabled": e,
            "pid": props.get("MainPID", ""),
            "since": props.get("ActiveEnterTimestamp", ""),
            "exists": os.path.exists(f"/etc/systemd/system/{name}.service"),
        }
    except Exception:
        return {"active": "error", "enabled": "error", "exists": False}


def svc_install_llama(c: dict, boot: bool) -> tuple[bool, str]:
    user = os.environ.get("SUDO_USER", os.environ.get("USER", "root"))
    body = _SVC_LLAMA.format(user=user, wd=str(APP_DIR), cmd=" ".join(build_cmd(c)))
    return _write_svc(LLAMA_SVC, body, boot)


def svc_install_manager(port: int, boot: bool) -> tuple[bool, str]:
    user = os.environ.get("SUDO_USER", os.environ.get("USER", "root"))
    body = _SVC_MANAGER.format(
        user=user,
        wd=str(APP_DIR),
        py=sys.executable,
        app=str(APP_DIR / "app.py"),
        port=port,
    )
    return _write_svc(MANAGER_SVC, body, boot)


def _write_svc(name: str, body: str, boot: bool) -> tuple[bool, str]:
    path = f"/etc/systemd/system/{name}.service"
    try:
        with open(path, "w") as f:
            f.write(body)
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        if boot:
            subprocess.run(["systemctl", "enable", name], check=True)
        return True, "Installed"
    except PermissionError:
        return False, "Permission denied — run manager as root or use sudo"
    except Exception as e:
        return False, str(e)


def svc_action(name: str, action: str) -> tuple[bool, str]:
    if action not in ("start", "stop", "restart", "enable", "disable"):
        return False, "Bad action"
    try:
        subprocess.run(["systemctl", action, name], check=True, capture_output=True)
        return True, f"{action} OK"
    except subprocess.CalledProcessError as e:
        return False, (e.stderr or b"").decode()[:300]
    except Exception as e:
        return False, str(e)


def svc_remove(name: str) -> tuple[bool, str]:
    try:
        svc_action(name, "stop")
        svc_action(name, "disable")
        path = f"/etc/systemd/system/{name}.service"
        if os.path.exists(path):
            os.remove(path)
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        return True, "Removed"
    except Exception as e:
        return False, str(e)


# ── Flask routes ─────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config", methods=["GET"])
def api_config_get():
    return jsonify(cfg_load())


@app.route("/api/config", methods=["POST"])
def api_config_set():
    c = cfg_load()
    c.update(request.json or {})
    cfg_save(c)
    return jsonify({"ok": True, "config": c})


@app.route("/api/models")
def api_models():
    c = cfg_load()
    return jsonify(discover_models(c.get("models_dir", DEFAULT_MODELS_DIR)))


@app.route("/api/server/start", methods=["POST"])
def api_start():
    c = cfg_load()
    if request.json:
        c.update(request.json)
        cfg_save(c)
    ok, msg = server_start(c)
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/server/stop", methods=["POST"])
def api_stop():
    ok, msg = server_stop()
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/server/restart", methods=["POST"])
def api_restart():
    server_stop()
    time.sleep(2)
    c = cfg_load()
    ok, msg = server_start(c)
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/server/status")
def api_status():
    running = _is_running()
    c = cfg_load()
    return jsonify(
        {
            "running": running,
            "pid": S.pid if running else None,
            "uptime": time.time() - S.start_time
            if S.start_time and running
            else 0,
            "health": get_llama_health(c) if running else None,
            "slots": get_llama_slots(c) if running else None,
        }
    )


@app.route("/api/server/logs")
def api_logs():
    with S.lock:
        return jsonify({"logs": list(S.log_buffer[-500:])})


@app.route("/api/metrics")
def api_metrics():
    c = cfg_load()
    running = _is_running()
    return jsonify(
        {
            "cpu": get_cpu(),
            "mem": get_mem(),
            "gpus": get_gpus(),
            "llama_health": get_llama_health(c) if running else None,
            "llama_metrics": get_llama_metrics_raw(c) if running else None,
            "ts": time.time(),
        }
    )


@app.route("/api/services")
def api_services():
    return jsonify(
        {LLAMA_SVC: svc_status(LLAMA_SVC), MANAGER_SVC: svc_status(MANAGER_SVC)}
    )


@app.route("/api/service/install", methods=["POST"])
def api_svc_install():
    d = request.json or {}
    svc = d.get("service", LLAMA_SVC)
    boot = d.get("boot", True)
    if svc == LLAMA_SVC:
        ok, msg = svc_install_llama(cfg_load(), boot)
    elif svc == MANAGER_SVC:
        ok, msg = svc_install_manager(d.get("port", 5000), boot)
    else:
        return jsonify({"ok": False, "msg": "unknown service"})
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/service/action", methods=["POST"])
def api_svc_action():
    d = request.json or {}
    ok, msg = svc_action(d.get("service", LLAMA_SVC), d.get("action", "status"))
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/service/remove", methods=["POST"])
def api_svc_remove():
    d = request.json or {}
    ok, msg = svc_remove(d.get("service", LLAMA_SVC))
    return jsonify({"ok": ok, "msg": msg})


@app.route("/api/system")
def api_sys():
    return jsonify(
        {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "hostname": platform.node(),
            "cpu": platform.processor() or "N/A",
            "cores": psutil.cpu_count(),
            "cores_phys": psutil.cpu_count(logical=False),
            "ram": psutil.virtual_memory().total,
            "binary": _find_binary(),
        }
    )


@app.route("/api/chat", methods=["POST"])
def api_chat():
    c = cfg_load()
    h = c.get("host", "127.0.0.1")
    if h == "0.0.0.0":
        h = "127.0.0.1"
    data = request.json or {}
    stream = data.get("stream", False)

    url = f"http://{h}:{c['port']}/v1/chat/completions"

    if stream:
        def gen():
            try:
                with requests.post(url, json=data, stream=True, timeout=600) as r:
                    for line in r.iter_lines():
                        if line:
                            yield line.decode() + "\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

        return Response(gen(), mimetype="text/event-stream")
    else:
        try:
            r = requests.post(url, json=data, timeout=600)
            return jsonify(r.json())
        except requests.ConnectionError:
            return jsonify({"error": "Cannot connect to llama-server"}), 503
        except Exception as e:
            return jsonify({"error": str(e)}), 500


@app.route("/api/command")
def api_command():
    c = cfg_load()
    if c.get("llama_server_path") and c.get("selected_model"):
        return jsonify({"cmd": " ".join(build_cmd(c))})
    return jsonify({"cmd": ""})


# ── SocketIO ─────────────────────────────────────────────────────────────────

@socketio.on("connect")
def ws_connect():
    emit("connected", {"ts": time.time()})


@socketio.on("get_logs")
def ws_logs():
    with S.lock:
        emit("logs_full", {"lines": list(S.log_buffer[-500:])})


def _bg_metrics():
    """Background thread: push metrics every ~1 s."""
    while True:
        try:
            c = cfg_load()
            running = _is_running()
            data = {
                "cpu": get_cpu(),
                "mem": get_mem(),
                "gpus": get_gpus(),
                "running": running,
                "pid": S.pid if running else None,
                "uptime": time.time() - S.start_time
                if S.start_time and running
                else 0,
                "llama_health": get_llama_health(c) if running else None,
                "llama_metrics": get_llama_metrics_raw(c) if running else None,
                "ts": time.time(),
            }
            socketio.emit("metrics", data)
        except Exception:
            pass
        socketio.sleep(1)


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    pa = argparse.ArgumentParser()
    pa.add_argument("--host", default="0.0.0.0")
    pa.add_argument("--port", type=int, default=5000)
    args = pa.parse_args()

    socketio.start_background_task(_bg_metrics)
    print(f"\n  🦙  Llama Manager → http://0.0.0.0:{args.port}\n")
    socketio.run(app, host=args.host, port=args.port,
                 debug=False, allow_unsafe_werkzeug=True)