#!/usr/bin/env python3
"""
LlamaServer Manager - Main Application
Web-based management interface for llama-server (llama.cpp)
"""

# gevent monkey-patching must happen before any other imports so that the
# standard library's threading, socket, etc. are replaced with gevent-aware
# equivalents.  This is required for Flask-SocketIO's gevent async mode to
# work correctly alongside background threading.Thread tasks.
from gevent import monkey as _gevent_monkey
_gevent_monkey.patch_all()

import os
import sys
import json
import time
import signal
import logging
import subprocess
import threading
import shlex
import shutil
import re
from pathlib import Path
from datetime import datetime, timedelta

from flask import Flask, render_template, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit

import psutil
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = BASE_DIR / "config"
CONFIG_FILE = CONFIG_DIR / "config.json"
LOG_DIR = Path("/var/log/llama-manager")

def load_config():
    """Load configuration from JSON file."""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logging.warning(f"Config file {CONFIG_FILE} is invalid ({e}), using defaults.")
            CONFIG_FILE.unlink(missing_ok=True)
    # Fallback defaults
    return {
        "install_dir": str(BASE_DIR),
        "models_dir": "/opt/models",
        "log_dir": str(LOG_DIR),
        "web_port": 8484,
        "llama_server_port": 8080,
        "llama_server_path": "/usr/local/bin/llama-server",
        "service_user": "llama",
        "gpu_type": "none",
        "gpu_name": "None",
        "cpu_cores": os.cpu_count() or 4,
        "cpu_threads": os.cpu_count() or 4,
        "total_ram_gb": round(psutil.virtual_memory().total / (1024**3), 1),
        "default_params": {
            "ctx_size": 4096,
            "n_predict": -1,
            "threads": max(1, (os.cpu_count() or 4) // 2),
            "threads_batch": os.cpu_count() or 4,
            "n_gpu_layers": 0,
            "flash_attn": False,
            "mlock": False,
            "mmap": True,
            "cache_type_k": "f16",
            "cache_type_v": "f16",
            "batch_size": 2048,
            "ubatch_size": 512,
            "cont_batching": True,
            "host": "0.0.0.0",
            "port": 8080,
            "parallel": 1,
            "temp": 0.7,
            "top_k": 40,
            "top_p": 0.95,
            "repeat_penalty": 1.1,
            "verbose": True,
        },
    }


def save_config(config):
    """Save configuration to JSON file."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=4)


config = load_config()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

LOG_DIR.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_DIR / "manager.log"),
    ],
)
logger = logging.getLogger("llama-manager")

# ---------------------------------------------------------------------------
# Flask App
# ---------------------------------------------------------------------------

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "app" / "templates"),
    static_folder=str(BASE_DIR / "app" / "static"),
)
app.config["SECRET_KEY"] = os.urandom(24).hex()

socketio = SocketIO(
    app,
    async_mode="gevent",
    cors_allowed_origins="*",
    ping_timeout=10,
    ping_interval=5,
)

# ---------------------------------------------------------------------------
# GPU Monitoring Helpers
# nvidia-ml-py is the official NVIDIA package (PyPI: nvidia-ml-py).
# It exposes the same 'pynvml' Python module as the older pynvml package.
# ---------------------------------------------------------------------------

nvidia_available = False
try:
    # The module name is 'pynvml' regardless of whether you installed it via
    # the legacy 'pynvml' package or the official 'nvidia-ml-py' package.
    import pynvml
    pynvml.nvmlInit()
    nvidia_available = True
    gpu_count = pynvml.nvmlDeviceGetCount()
    logger.info(
        f"NVIDIA GPU monitoring enabled via nvidia-ml-py (pynvml); "
        f"{gpu_count} GPU(s) detected"
    )
except ImportError:
    logger.warning(
        "nvidia-ml-py (pynvml) not installed – GPU metrics disabled. "
        "Install with: pip install nvidia-ml-py"
    )
except Exception as exc:
    logger.warning(f"NVIDIA GPU init failed – GPU metrics disabled: {exc}")


def get_nvidia_metrics():
    """Return NVIDIA GPU metrics dict, or empty dict if unavailable."""
    if not nvidia_available:
        logger.debug("get_nvidia_metrics: nvidia not available, returning {}")
        return {}
    try:
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        util = pynvml.nvmlDeviceGetUtilizationRates(handle)
        mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
        temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
        try:
            power = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
            power_limit = pynvml.nvmlDeviceGetPowerManagementLimit(handle) / 1000.0
        except pynvml.NVMLError:
            power = 0
            power_limit = 0
        try:
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8")
        except Exception:
            name = "NVIDIA GPU"
        try:
            fan = pynvml.nvmlDeviceGetFanSpeed(handle)
        except pynvml.NVMLError:
            fan = -1
        try:
            clk_gpu = pynvml.nvmlDeviceGetClockInfo(handle, pynvml.NVML_CLOCK_GRAPHICS)
            clk_mem = pynvml.nvmlDeviceGetClockInfo(handle, pynvml.NVML_CLOCK_MEM)
        except pynvml.NVMLError:
            clk_gpu = 0
            clk_mem = 0

        metrics = {
            "name": name,
            "gpu_util": util.gpu,
            "mem_util": util.memory,
            "mem_used_mb": round(mem_info.used / (1024**2)),
            "mem_total_mb": round(mem_info.total / (1024**2)),
            "mem_free_mb": round(mem_info.free / (1024**2)),
            "temperature": temp,
            "power_draw_w": round(power, 1),
            "power_limit_w": round(power_limit, 1),
            "fan_speed": fan,
            "clock_gpu_mhz": clk_gpu,
            "clock_mem_mhz": clk_mem,
        }
        logger.debug(
            f"[SENSOR] GPU: {name} util={util.gpu}% mem={metrics['mem_used_mb']}/"
            f"{metrics['mem_total_mb']}MB temp={temp}°C power={round(power,1)}W"
        )
        return metrics
    except Exception as exc:
        logger.warning(f"[SENSOR] GPU metrics error: {exc}")
        return {}


def get_cpu_temperature():
    """Return CPU temperature (°C) if available, else None."""
    try:
        temps = psutil.sensors_temperatures()
        if not temps:
            logger.debug("[SENSOR] CPU temp: sensors_temperatures() returned empty dict")
            return None
        for chip in ("coretemp", "k10temp", "zenpower", "cpu_thermal", "acpitz"):
            if chip in temps:
                readings = temps[chip]
                if readings:
                    val = round(max(r.current for r in readings), 1)
                    logger.debug(f"[SENSOR] CPU temp from '{chip}': {val} °C")
                    return val
        # Fallback: first available chip
        for chip, readings in temps.items():
            if readings:
                val = round(readings[0].current, 1)
                logger.debug(f"[SENSOR] CPU temp fallback from '{chip}': {val} °C")
                return val
        logger.debug("[SENSOR] CPU temp: no suitable sensor found")
    except Exception as exc:
        logger.warning(f"[SENSOR] CPU temperature read error: {exc}")
    return None


# ---------------------------------------------------------------------------
# llama-server Process Manager
# ---------------------------------------------------------------------------

class LlamaServerManager:
    """Manages the llama-server process lifecycle."""

    def __init__(self):
        self.process: subprocess.Popen | None = None
        self.running = False
        self.current_model: str | None = None
        self.current_params: dict = {}
        self.start_time: datetime | None = None
        self.log_buffer: list[str] = []
        self.max_log_lines = 500
        self._lock = threading.Lock()
        self._log_thread: threading.Thread | None = None
        self._stats_cache: dict = {}
        self._stats_cache_time: float = 0

    # -- Model discovery ------------------------------------------------

    def get_available_models(self) -> list[dict]:
        """Scan models directory for .gguf files."""
        models_dir = Path(config.get("models_dir", "/opt/models"))
        models = []
        if not models_dir.exists():
            return models
        for f in sorted(models_dir.rglob("*.gguf")):
            try:
                stat = f.stat()
                size_gb = round(stat.st_size / (1024**3), 2)
                models.append({
                    "name": f.name,
                    "path": str(f),
                    "size_bytes": stat.st_size,
                    "size_gb": size_gb,
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    "relative_path": str(f.relative_to(models_dir)),
                    "directory": str(f.parent.relative_to(models_dir))
                    if f.parent != models_dir
                    else "",
                })
            except OSError:
                continue
        return models

    # -- Build command line -----------------------------------------------

    def build_command(self, model_path: str, params: dict) -> list[str]:
        """Build the llama-server command line from parameters."""
        server_path = config.get("llama_server_path", "llama-server")
        cmd = [server_path]

        cmd.extend(["--model", model_path])
        cmd.extend(["--host", str(params.get("host", "0.0.0.0"))])
        cmd.extend(["--port", str(params.get("port", config.get("llama_server_port", 8080)))])
        cmd.extend(["--ctx-size", str(params.get("ctx_size", 4096))])
        cmd.extend(["--threads", str(params.get("threads", 4))])
        cmd.extend(["--threads-batch", str(params.get("threads_batch", 4))])
        cmd.extend(["--batch-size", str(params.get("batch_size", 2048))])
        cmd.extend(["--ubatch-size", str(params.get("ubatch_size", 512))])
        cmd.extend(["--n-predict", str(params.get("n_predict", -1))])
        cmd.extend(["--parallel", str(params.get("parallel", 1))])
        cmd.extend(["--n-gpu-layers", str(params.get("n_gpu_layers", 0))])
        cmd.extend(["--cache-type-k", str(params.get("cache_type_k", "f16"))])
        cmd.extend(["--cache-type-v", str(params.get("cache_type_v", "f16"))])

        if params.get("flash_attn", False):
            cmd.append("--flash-attn")
        if params.get("mlock", False):
            cmd.append("--mlock")
        if params.get("mmap", True):
            cmd.append("--mmap")
        else:
            cmd.append("--no-mmap")
        if params.get("cont_batching", True):
            cmd.append("--cont-batching")
        if params.get("verbose", False):
            cmd.append("--verbose")

        # Sampling defaults (applied server-wide)
        # llama-server doesn't take all sampling params on CLI in every version,
        # but the common ones are accepted:
        for cli_flag, key in [
            ("--temp", "temp"),
            ("--top-k", "top_k"),
            ("--top-p", "top_p"),
            ("--repeat-penalty", "repeat_penalty"),
        ]:
            if key in params:
                cmd.extend([cli_flag, str(params[key])])

        return cmd

    # -- Start / Stop -----------------------------------------------------

    def start(self, model_path: str, params: dict) -> tuple[bool, str]:
        """Start llama-server with given model and parameters."""
        with self._lock:
            if self.running and self.process and self.process.poll() is None:
                return False, "Server is already running"

            if not Path(model_path).exists():
                return False, f"Model file not found: {model_path}"

            server_path = config.get("llama_server_path", "llama-server")
            if not Path(server_path).exists() and not shutil.which(server_path):
                return False, f"llama-server not found: {server_path}"

            cmd = self.build_command(model_path, params)
            cmd_str = " ".join(shlex.quote(c) for c in cmd)
            logger.info(f"Starting llama-server: {cmd_str}")
            self.log_buffer.clear()
            self._append_log(f"[MANAGER] Starting: {cmd_str}")

            try:
                self.process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    preexec_fn=os.setsid,
                )
            except FileNotFoundError:
                msg = f"llama-server binary not found at: {server_path}"
                logger.error(msg)
                return False, msg
            except Exception as exc:
                msg = f"Failed to start: {exc}"
                logger.error(msg)
                return False, msg

            self.running = True
            self.current_model = model_path
            self.current_params = params.copy()
            self.start_time = datetime.now()

            # Log reader thread
            self._log_thread = threading.Thread(
                target=self._read_output, daemon=True
            )
            self._log_thread.start()

            # Save last-used params
            config["default_params"] = params
            config["last_model"] = model_path
            save_config(config)

            return True, "Server starting..."

    def stop(self) -> tuple[bool, str]:
        """Stop the running llama-server."""
        with self._lock:
            if not self.running or not self.process:
                return False, "Server is not running"

            self._append_log("[MANAGER] Stopping server...")
            logger.info("Stopping llama-server")

            try:
                os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass

            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                logger.warning("Graceful stop timed out, force killing")
                try:
                    os.killpg(os.getpgid(self.process.pid), signal.SIGKILL)
                    self.process.wait(timeout=5)
                except Exception:
                    pass

            self.running = False
            self.process = None
            self.current_model = None
            self.start_time = None
            self._append_log("[MANAGER] Server stopped")

            return True, "Server stopped"

    def restart(self, model_path: str | None = None, params: dict | None = None) -> tuple[bool, str]:
        """Restart llama-server, optionally with new params."""
        m = model_path or self.current_model
        p = params or self.current_params
        if not m:
            return False, "No model specified"
        self.stop()
        time.sleep(1)
        return self.start(m, p)

    # -- Status -----------------------------------------------------------

    def get_status(self) -> dict:
        """Get current server status."""
        proc_info = {}
        if self.process and self.process.poll() is None:
            try:
                p = psutil.Process(self.process.pid)
                mem = p.memory_info()
                proc_info = {
                    "pid": self.process.pid,
                    "cpu_percent": p.cpu_percent(interval=0),
                    "rss_mb": round(mem.rss / (1024**2)),
                    "vms_mb": round(mem.vms / (1024**2)),
                    "threads": p.num_threads(),
                }
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass

        uptime = None
        if self.start_time and self.running:
            uptime = str(datetime.now() - self.start_time).split(".")[0]

        return {
            "running": self.running and self.process is not None and self.process.poll() is None,
            "model": self.current_model,
            "model_name": Path(self.current_model).name if self.current_model else None,
            "params": self.current_params,
            "uptime": uptime,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "process": proc_info,
        }

    def get_llama_health(self) -> dict:
        """Query llama-server /health endpoint."""
        port = self.current_params.get("port", config.get("llama_server_port", 8080))
        try:
            r = requests.get(f"http://127.0.0.1:{port}/health", timeout=2)
            return r.json()
        except Exception:
            return {"status": "unavailable"}

    def get_llama_slots(self) -> list:
        """Query llama-server /slots endpoint."""
        port = self.current_params.get("port", config.get("llama_server_port", 8080))
        try:
            r = requests.get(f"http://127.0.0.1:{port}/slots", timeout=2)
            return r.json()
        except Exception:
            return []

    def get_llama_metrics(self) -> str:
        """Query llama-server /metrics (prometheus) endpoint."""
        port = self.current_params.get("port", config.get("llama_server_port", 8080))
        try:
            r = requests.get(f"http://127.0.0.1:{port}/metrics", timeout=2)
            return r.text
        except Exception:
            return ""

    def parse_metrics(self) -> dict:
        """Parse prometheus metrics into a dict."""
        now = time.time()
        if now - self._stats_cache_time < 0.5 and self._stats_cache:
            return self._stats_cache

        raw = self.get_llama_metrics()
        metrics = {}
        for line in raw.splitlines():
            if line.startswith("#") or not line.strip():
                continue
            # e.g. llama_prompt_tokens_total 123
            parts = line.split()
            if len(parts) >= 2:
                key = parts[0]
                try:
                    val = float(parts[1])
                except ValueError:
                    val = parts[1]
                metrics[key] = val

        self._stats_cache = metrics
        self._stats_cache_time = now
        return metrics

    # -- Logs -------------------------------------------------------------

    def _append_log(self, line: str):
        ts = datetime.now().strftime("%H:%M:%S")
        entry = f"[{ts}] {line}"
        self.log_buffer.append(entry)
        if len(self.log_buffer) > self.max_log_lines:
            self.log_buffer = self.log_buffer[-self.max_log_lines:]
        # Emit via socketio in a safe way
        try:
            socketio.emit("log_line", {"line": entry}, namespace="/")
        except Exception:
            pass

    def _read_output(self):
        """Read stdout/stderr from the subprocess."""
        try:
            for line in self.process.stdout:
                line = line.rstrip("\n")
                self._append_log(line)
        except Exception:
            pass
        finally:
            # Process ended
            with self._lock:
                if self.running:
                    self.running = False
                    exit_code = self.process.returncode if self.process else "?"
                    self._append_log(f"[MANAGER] Process exited with code {exit_code}")
                    logger.warning(f"llama-server process exited (code {exit_code})")

    def get_logs(self, last_n: int = 200) -> list[str]:
        return self.log_buffer[-last_n:]

    # -- Systemd Service management ----------------------------------------

    @staticmethod
    def is_service_installed(service: str = "llama-server") -> bool:
        result = subprocess.run(
            ["systemctl", "list-unit-files", f"{service}.service"],
            capture_output=True, text=True,
        )
        return service in result.stdout

    @staticmethod
    def is_service_enabled(service: str = "llama-server") -> bool:
        result = subprocess.run(
            ["systemctl", "is-enabled", f"{service}.service"],
            capture_output=True, text=True,
        )
        return result.stdout.strip() == "enabled"

    @staticmethod
    def is_service_active(service: str = "llama-server") -> bool:
        result = subprocess.run(
            ["systemctl", "is-active", f"{service}.service"],
            capture_output=True, text=True,
        )
        return result.stdout.strip() == "active"

    @staticmethod
    def service_action(service: str, action: str) -> tuple[bool, str]:
        """Run systemctl action (start/stop/restart/enable/disable)."""
        if action not in ("start", "stop", "restart", "enable", "disable", "daemon-reload"):
            return False, f"Invalid action: {action}"
        result = subprocess.run(
            ["systemctl", action, f"{service}.service"],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            return True, f"Service {service} {action} successful"
        return False, result.stderr.strip() or f"Failed to {action} {service}"

    def install_service_env(self, model_path: str, params: dict) -> tuple[bool, str]:
        """Write the environment file used by the systemd llama-server service."""
        cmd = self.build_command(model_path, params)
        # The service ExecStart just calls llama-server, so we write all args
        # We rewrite the service file's ExecStart to include the full command
        server_path = config.get("llama_server_path", "llama-server")
        exec_line = " ".join(shlex.quote(c) for c in cmd)

        service_content = f"""[Unit]
Description=llama.cpp Server
After=network.target
Wants=network.target

[Service]
Type=simple
User={config.get('service_user', 'root')}
Group={config.get('service_user', 'root')}
WorkingDirectory={config.get('install_dir', '/opt/llama-manager')}
ExecStart={exec_line}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=llama-server
LimitNOFILE=65536
LimitMEMLOCK=infinity

[Install]
WantedBy=multi-user.target
"""
        try:
            service_path = Path("/etc/systemd/system/llama-server.service")
            service_path.write_text(service_content)
            subprocess.run(["systemctl", "daemon-reload"], capture_output=True)
            logger.info("llama-server.service updated and daemon reloaded")
            return True, "Service file updated successfully"
        except Exception as exc:
            return False, f"Failed to write service file: {exc}"


# Global server manager instance
server_manager = LlamaServerManager()

# ---------------------------------------------------------------------------
# System Metrics Collection (background thread)
# ---------------------------------------------------------------------------

system_metrics = {
    "cpu": {},
    "memory": {},
    "gpu": {},
    "disk": {},
    "network": {},
    "timestamp": 0,
}
metrics_lock = threading.Lock()


def collect_system_metrics():
    """Background thread: collect system metrics every ~1s."""
    _first_run = True
    while True:
        try:
            cpu_percent = psutil.cpu_percent(interval=0.5, percpu=False)
            cpu_per_core = psutil.cpu_percent(interval=0, percpu=True)
            cpu_freq = psutil.cpu_freq()
            mem = psutil.virtual_memory()
            swap = psutil.swap_memory()
            disk = psutil.disk_usage("/")
            cpu_temp = get_cpu_temperature()

            # Load averages
            try:
                load1, load5, load15 = os.getloadavg()
            except OSError:
                load1 = load5 = load15 = 0

            gpu = get_nvidia_metrics()

            cpu_data = {
                "percent": cpu_percent,
                "per_core": cpu_per_core,
                "freq_current": round(cpu_freq.current, 0) if cpu_freq else 0,
                "freq_max": round(cpu_freq.max, 0) if cpu_freq and cpu_freq.max else 0,
                "temperature": cpu_temp,
                "load_1m": round(load1, 2),
                "load_5m": round(load5, 2),
                "load_15m": round(load15, 2),
                "core_count": psutil.cpu_count(logical=False) or 0,
                "thread_count": psutil.cpu_count(logical=True) or 0,
            }
            mem_data = {
                "total_mb": round(mem.total / (1024**2)),
                "used_mb": round(mem.used / (1024**2)),
                "available_mb": round(mem.available / (1024**2)),
                "percent": mem.percent,
                "swap_total_mb": round(swap.total / (1024**2)),
                "swap_used_mb": round(swap.used / (1024**2)),
                "swap_percent": swap.percent,
            }
            disk_data = {
                "total_gb": round(disk.total / (1024**3), 1),
                "used_gb": round(disk.used / (1024**3), 1),
                "free_gb": round(disk.free / (1024**3), 1),
                "percent": round(disk.percent, 1),
            }

            with metrics_lock:
                system_metrics["cpu"] = cpu_data
                system_metrics["memory"] = mem_data
                system_metrics["gpu"] = gpu
                system_metrics["disk"] = disk_data
                system_metrics["timestamp"] = time.time()

            # Log detailed sensor data on first successful collection and then
            # every 60 seconds so the log isn't flooded but debugging is easy.
            if _first_run:
                logger.info(
                    f"[SENSOR] First metrics collected – "
                    f"CPU: {cpu_percent:.1f}%  "
                    f"MEM: {mem_data['used_mb']}/{mem_data['total_mb']} MB ({mem.percent:.1f}%)  "
                    f"DISK: {disk_data['used_gb']}/{disk_data['total_gb']} GB  "
                    f"CPU_TEMP: {cpu_temp}°C  "
                    f"GPU: {'present' if gpu else 'not detected'}"
                )
                _first_run = False
            else:
                logger.debug(
                    f"[SENSOR] CPU={cpu_percent:.1f}% "
                    f"MEM={mem.percent:.1f}% "
                    f"DISK={disk_data['percent']}% "
                    f"CPU_TEMP={cpu_temp} "
                    f"GPU_util={gpu.get('gpu_util', 'N/A')}%"
                )

        except Exception as exc:
            logger.error(f"[SENSOR] Metrics collection error: {exc}", exc_info=True)

        time.sleep(0.8)


# Start metrics collection thread
metrics_thread = threading.Thread(target=collect_system_metrics, daemon=True)
metrics_thread.start()

# ---------------------------------------------------------------------------
# Parameter Definitions (info blocks)
# ---------------------------------------------------------------------------

PARAMETER_INFO = {
    "ctx_size": {
        "label": "Context Size",
        "description": "Maximum context length (number of tokens the model can consider at once).",
        "detail": "This sets the size of the KV cache. Larger values allow the model to remember more of the conversation but consume significantly more RAM/VRAM. The relationship is roughly linear: doubling context size doubles KV cache memory usage. Most models are trained with specific context sizes (e.g., 2048, 4096, 8192). Going beyond the training context may degrade quality unless the model supports extended context (e.g., via RoPE scaling).",
        "increase_effect": "More conversation history retained, better long-document understanding. Higher memory usage (can cause OOM). May slow down prompt processing.",
        "decrease_effect": "Less memory usage, faster processing. Model forgets earlier parts of conversation sooner. Good for simple Q&A tasks.",
        "type": "number",
        "min": 128,
        "max": 131072,
        "step": 256,
        "default": 4096,
        "unit": "tokens",
        "category": "memory",
    },
    "threads": {
        "label": "CPU Threads (Generation)",
        "description": "Number of CPU threads used during token generation (inference).",
        "detail": "Controls parallelism during the autoregressive generation phase where tokens are produced one at a time. This is the main bottleneck for CPU inference. Setting this to the number of physical cores (not hyperthreads) usually gives the best performance. Using more threads than physical cores can actually decrease performance due to cache contention and context switching overhead.",
        "increase_effect": "Better utilization of multi-core CPUs. Diminishing returns past physical core count. May cause contention if set too high (above physical cores).",
        "decrease_effect": "Lower CPU usage, leaves cores free for other tasks. Slower token generation speed (tokens/second).",
        "type": "number",
        "min": 1,
        "max": 256,
        "step": 1,
        "default": max(1, (os.cpu_count() or 4) // 2),
        "unit": "threads",
        "category": "performance",
    },
    "threads_batch": {
        "label": "CPU Threads (Batch/Prompt Processing)",
        "description": "Number of CPU threads used during prompt processing (batch evaluation).",
        "detail": "Controls parallelism during the prompt processing phase where the entire input is evaluated at once. This phase is more parallelizable than generation, so using all available threads (including hyperthreads) is often beneficial. Prompt processing is done once per request, so this affects the initial latency before generation begins.",
        "increase_effect": "Faster prompt processing (lower time-to-first-token). Can use all logical threads effectively. Higher momentary CPU usage.",
        "decrease_effect": "Slower prompt processing. Lower CPU usage during prompt evaluation.",
        "type": "number",
        "min": 1,
        "max": 256,
        "step": 1,
        "default": os.cpu_count() or 4,
        "unit": "threads",
        "category": "performance",
    },
    "n_gpu_layers": {
        "label": "GPU Layers",
        "description": "Number of model layers to offload to the GPU.",
        "detail": "Models consist of many transformer layers (typically 32-80+). Each offloaded layer uses GPU VRAM but processes much faster than on CPU. Setting this to 0 means pure CPU inference. Setting it to a very high number (e.g., 999) offloads all layers to GPU. Partial offloading is possible: some layers on GPU, rest on CPU. The first and last layers have the most impact. VRAM usage scales roughly linearly with the number of offloaded layers.",
        "increase_effect": "Faster inference (GPU is much faster than CPU for matrix operations). Higher VRAM usage. Each layer typically uses VRAM = model_size / total_layers.",
        "decrease_effect": "Less VRAM usage. Slower inference as more computation happens on CPU. Set to 0 for pure CPU mode.",
        "type": "number",
        "min": 0,
        "max": 999,
        "step": 1,
        "default": 0,
        "unit": "layers",
        "category": "gpu",
    },
    "batch_size": {
        "label": "Batch Size",
        "description": "Logical maximum batch size for prompt processing.",
        "detail": "Maximum number of tokens to process in a single batch during prompt evaluation. Larger batch sizes can improve prompt processing throughput but use more memory. This is the logical batch size; the actual processing is done in micro-batches (ubatch_size). The batch size should be >= ubatch_size. For most use cases, 2048 is a good default.",
        "increase_effect": "Can process longer prompts more efficiently. Slightly higher memory usage during prompt processing. Better throughput for long inputs.",
        "decrease_effect": "May slow down prompt processing for long inputs. Slightly lower peak memory usage.",
        "type": "number",
        "min": 32,
        "max": 16384,
        "step": 128,
        "default": 2048,
        "unit": "tokens",
        "category": "performance",
    },
    "ubatch_size": {
        "label": "Micro-batch Size",
        "description": "Physical maximum batch size for GGML computation.",
        "detail": "The actual batch size used for matrix multiplication operations. Smaller values reduce memory usage but may be less efficient. Must be <= batch_size. This controls the granularity of computation. For GPU inference, larger ubatch sizes tend to be more efficient as they better utilize GPU parallelism. For CPU, the impact is less significant.",
        "increase_effect": "Better GPU utilization and throughput. Higher momentary memory usage. More efficient matrix operations.",
        "decrease_effect": "Lower memory usage during processing. Potentially slower due to less efficient GPU utilization. Useful if running out of VRAM.",
        "type": "number",
        "min": 16,
        "max": 8192,
        "step": 64,
        "default": 512,
        "unit": "tokens",
        "category": "performance",
    },
    "n_predict": {
        "label": "Max Tokens to Predict",
        "description": "Maximum number of tokens to generate per request (-1 = unlimited).",
        "detail": "Sets an upper limit on generated tokens per completion request. -1 means no limit (generate until EOS token or context full). This is a safety limit to prevent runaway generation. Individual API requests can override this with a smaller value.",
        "increase_effect": "Allows longer responses. Risk of very long generation times. May fill context window.",
        "decrease_effect": "Limits response length. Faster guaranteed completion. Prevents runaway generation.",
        "type": "number",
        "min": -1,
        "max": 131072,
        "step": 256,
        "default": -1,
        "unit": "tokens",
        "category": "generation",
    },
    "parallel": {
        "label": "Parallel Requests",
        "description": "Number of simultaneous request slots.",
        "detail": "How many requests can be processed concurrently. Each parallel slot maintains its own KV cache, so memory usage scales with: parallel × ctx_size × per-token-memory. Continuous batching allows these parallel requests to share computation efficiently. For single-user setups, 1 is sufficient. For multi-user or API serving, increase based on expected concurrency.",
        "increase_effect": "Handle more simultaneous users/requests. Significantly higher memory usage (each slot needs its own KV cache). May reduce per-request throughput.",
        "decrease_effect": "Lower memory usage. Requests are queued and processed sequentially. Better per-request performance.",
        "type": "number",
        "min": 1,
        "max": 64,
        "step": 1,
        "default": 1,
        "unit": "slots",
        "category": "server",
    },
    "flash_attn": {
        "label": "Flash Attention",
        "description": "Enable Flash Attention for faster and more memory-efficient attention computation.",
        "detail": "Flash Attention is an optimized attention algorithm that reduces memory usage from O(n²) to O(n) and improves speed by minimizing memory reads/writes. It achieves this by tiling the attention computation and never materializing the full attention matrix. Requires compatible hardware and model format. Highly recommended when available as it provides significant speedups with large context sizes.",
        "increase_effect": "Significantly faster attention computation. Much lower memory usage for large context sizes. Better scaling to long sequences.",
        "decrease_effect": "Standard attention is used. Higher memory usage with large contexts. Slower for long sequences. More compatible across hardware.",
        "type": "boolean",
        "default": False,
        "category": "gpu",
    },
    "mlock": {
        "label": "Memory Lock (mlock)",
        "description": "Lock the model in RAM to prevent swapping to disk.",
        "detail": "Uses the mlock() system call to prevent the OS from swapping the model's memory pages to disk. This ensures consistent performance by keeping the entire model in physical RAM. Requires sufficient RAM and appropriate system limits (ulimit -l). If the system doesn't have enough RAM, enabling this will cause the server to fail to start.",
        "increase_effect": "Consistent inference speed (no swap-related slowdowns). Guarantees model stays in RAM. Prevents other processes from causing the model to be swapped out.",
        "decrease_effect": "OS may swap model pages under memory pressure, causing severe slowdowns. More flexible memory management. Works even with less RAM than model size (but very slow).",
        "type": "boolean",
        "default": False,
        "category": "memory",
    },
    "mmap": {
        "label": "Memory Map (mmap)",
        "description": "Use memory-mapped I/O for model loading.",
        "detail": "Memory-maps the model file instead of reading it entirely into RAM. This allows the OS to manage which parts of the model are in RAM vs. on disk, enabling lazy loading and shared memory between processes. Faster initial loading time. Recommended for most use cases. Disable only if you experience issues with specific filesystems (e.g., network mounts).",
        "increase_effect": "Faster model loading. Lower initial memory spike. OS manages page cache efficiently. Multiple instances can share physical memory pages.",
        "decrease_effect": "Model is fully read into RAM at startup. Slower startup. Predictable memory usage. Required for some network filesystems.",
        "type": "boolean",
        "default": True,
        "category": "memory",
    },
    "cont_batching": {
        "label": "Continuous Batching",
        "description": "Enable continuous batching for better throughput with parallel requests.",
        "detail": "Continuous batching dynamically batches tokens from different requests together, improving GPU utilization when handling multiple concurrent requests. Without it, the server processes one request at a time. This is essential for production deployments with multiple users.",
        "increase_effect": "Much better throughput with multiple concurrent requests. Better GPU utilization. Essential for multi-user scenarios.",
        "decrease_effect": "Simple sequential processing. Slightly less overhead for single-user use. More predictable per-request latency.",
        "type": "boolean",
        "default": True,
        "category": "server",
    },
    "cache_type_k": {
        "label": "KV Cache Type (Keys)",
        "description": "Data type for the key cache in the KV cache.",
        "detail": "The KV (Key-Value) cache stores attention keys and values for previously processed tokens. Using lower precision types (quantization) reduces memory usage at a potential quality cost. Options: f32 (full precision), f16 (half precision, recommended), q8_0 (8-bit quantization), q4_0 (4-bit quantization). f16 is the standard choice with negligible quality loss. q8_0 halves memory vs f16 with minimal quality impact. q4_0 quarters memory but may affect output quality.",
        "increase_effect": "f32: Highest precision, 2× memory vs f16. Negligible quality improvement over f16.",
        "decrease_effect": "q8_0: Half memory of f16, minimal quality loss. q4_0: Quarter memory of f16, some quality degradation. Great for fitting larger contexts in limited VRAM.",
        "type": "select",
        "options": ["f32", "f16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"],
        "default": "f16",
        "category": "memory",
    },
    "cache_type_v": {
        "label": "KV Cache Type (Values)",
        "description": "Data type for the value cache in the KV cache.",
        "detail": "Similar to cache_type_k but for the value vectors. The value cache typically has a similar memory footprint to the key cache. Using quantized types reduces memory proportionally. It's common to use the same type for both K and V caches, but you can mix (e.g., f16 for keys, q8_0 for values) if desired.",
        "increase_effect": "Higher precision values. More memory usage. Slightly better output quality (usually negligible vs f16).",
        "decrease_effect": "Lower precision values. Less memory usage. Allows larger context sizes or more parallel slots. q8_0 is a good compromise.",
        "type": "select",
        "options": ["f32", "f16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"],
        "default": "f16",
        "category": "memory",
    },
    "temp": {
        "label": "Temperature",
        "description": "Sampling temperature for controlling randomness.",
        "detail": "Controls the randomness of token selection. Lower values make the model more deterministic and focused, while higher values increase creativity and diversity. At temperature 0, the model always picks the most likely token (greedy decoding). At temperature 1.0, sampling follows the model's learned probability distribution. Values above 1.0 make the distribution more uniform (more random).",
        "increase_effect": "More creative and diverse outputs. Higher chance of unexpected or incoherent text. Better for creative writing, brainstorming.",
        "decrease_effect": "More deterministic and focused outputs. Tends to repeat common patterns. Better for factual Q&A, code generation.",
        "type": "float",
        "min": 0.0,
        "max": 2.0,
        "step": 0.05,
        "default": 0.7,
        "category": "sampling",
    },
    "top_k": {
        "label": "Top-K",
        "description": "Limit sampling to the top K most probable tokens.",
        "detail": "At each generation step, only the K tokens with the highest probabilities are considered. All other tokens are excluded. This prevents the model from selecting very unlikely tokens. Lower values restrict choices more. Setting to 0 disables top-k filtering. Works in conjunction with top-p and temperature.",
        "increase_effect": "More diverse vocabulary in outputs. Less filtering of low-probability tokens. Model can occasionally pick surprising words.",
        "decrease_effect": "More focused/predictable outputs. Only very likely tokens are selected. May reduce diversity excessively if too low.",
        "type": "number",
        "min": 0,
        "max": 500,
        "step": 1,
        "default": 40,
        "category": "sampling",
    },
    "top_p": {
        "label": "Top-P (Nucleus Sampling)",
        "description": "Limit sampling to tokens comprising the top P cumulative probability.",
        "detail": "Also known as nucleus sampling. Instead of a fixed number of tokens (top-k), this considers the smallest set of tokens whose cumulative probability exceeds P. This adapts to the model's confidence: when the model is very confident, fewer tokens are considered; when uncertain, more tokens are included. A value of 0.95 means 'consider tokens until their probabilities sum to 95%'.",
        "increase_effect": "More tokens considered. Higher diversity. At 1.0, all tokens are candidates (top-p disabled).",
        "decrease_effect": "Fewer tokens considered. More focused outputs. At very low values (e.g., 0.1), only the most probable tokens are used.",
        "type": "float",
        "min": 0.0,
        "max": 1.0,
        "step": 0.05,
        "default": 0.95,
        "category": "sampling",
    },
    "repeat_penalty": {
        "label": "Repeat Penalty",
        "description": "Penalty applied to tokens that have already appeared in the output.",
        "detail": "Reduces the probability of tokens that have already been generated, discouraging repetition. A value of 1.0 means no penalty. Values > 1.0 reduce repetition. Values < 1.0 encourage repetition. Applied to the last repeat_last_n tokens (default 64). Too high values can make the model avoid using common words, producing unnatural text.",
        "increase_effect": "Stronger discouragement of repetition. More diverse vocabulary usage. May produce unnatural text if too high (avoids common words). Good for creative writing.",
        "decrease_effect": "Model may repeat phrases or get stuck in loops. More natural token distribution. Value of 1.0 disables the penalty entirely.",
        "type": "float",
        "min": 0.0,
        "max": 2.0,
        "step": 0.05,
        "default": 1.1,
        "category": "sampling",
    },
    "host": {
        "label": "Listen Address",
        "description": "Network address the server listens on.",
        "detail": "The IP address or hostname the llama-server binds to. '0.0.0.0' listens on all network interfaces (accessible from other machines). '127.0.0.1' listens only on localhost (local access only). For security, use 127.0.0.1 unless you need remote access and have proper firewalling.",
        "increase_effect": "N/A",
        "decrease_effect": "N/A",
        "type": "text",
        "default": "0.0.0.0",
        "category": "server",
    },
    "port": {
        "label": "Server Port",
        "description": "TCP port for the llama-server API.",
        "detail": "The port number on which llama-server listens for HTTP API requests. Default is 8080. Make sure this port is not used by another service. The Web UI connects to this port to proxy chat requests and gather metrics.",
        "type": "number",
        "min": 1024,
        "max": 65535,
        "step": 1,
        "default": 8080,
        "unit": "port",
        "category": "server",
    },
    "verbose": {
        "label": "Verbose Logging",
        "description": "Enable verbose output from llama-server.",
        "detail": "When enabled, llama-server outputs detailed information about model loading, memory usage, performance metrics, and per-request statistics. Useful for debugging and monitoring but produces a lot of output. Recommended to keep enabled during setup and tuning.",
        "type": "boolean",
        "default": True,
        "category": "server",
    },
}

# ---------------------------------------------------------------------------
# Flask Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config", methods=["GET"])
def api_get_config():
    return jsonify(config)


@app.route("/api/config", methods=["POST"])
def api_update_config():
    global config
    data = request.json
    if data:
        config.update(data)
        save_config(config)
    return jsonify({"ok": True, "config": config})


@app.route("/api/params/info", methods=["GET"])
def api_params_info():
    return jsonify(PARAMETER_INFO)


@app.route("/api/models", methods=["GET"])
def api_list_models():
    models = server_manager.get_available_models()
    return jsonify({"models": models, "models_dir": config.get("models_dir", "/opt/models")})


@app.route("/api/server/status", methods=["GET"])
def api_server_status():
    status = server_manager.get_status()
    health = server_manager.get_llama_health()
    return jsonify({"status": status, "health": health})


@app.route("/api/server/start", methods=["POST"])
def api_server_start():
    data = request.json or {}
    model_path = data.get("model_path")
    params = data.get("params", config.get("default_params", {}))
    if not model_path:
        return jsonify({"ok": False, "error": "model_path is required"}), 400
    ok, msg = server_manager.start(model_path, params)
    return jsonify({"ok": ok, "message": msg})


@app.route("/api/server/stop", methods=["POST"])
def api_server_stop():
    ok, msg = server_manager.stop()
    return jsonify({"ok": ok, "message": msg})


@app.route("/api/server/restart", methods=["POST"])
def api_server_restart():
    data = request.json or {}
    model_path = data.get("model_path", server_manager.current_model)
    params = data.get("params", server_manager.current_params)
    ok, msg = server_manager.restart(model_path, params)
    return jsonify({"ok": ok, "message": msg})


@app.route("/api/server/logs", methods=["GET"])
def api_server_logs():
    last_n = request.args.get("n", 200, type=int)
    return jsonify({"logs": server_manager.get_logs(last_n)})


@app.route("/api/server/metrics", methods=["GET"])
def api_server_metrics():
    metrics = server_manager.parse_metrics()
    slots = server_manager.get_llama_slots()
    return jsonify({"metrics": metrics, "slots": slots})


@app.route("/api/system/metrics", methods=["GET"])
def api_system_metrics():
    with metrics_lock:
        data = dict(system_metrics)
    return jsonify(data)


@app.route("/api/service/status", methods=["GET"])
def api_service_status():
    services = {}
    for svc in ("llama-server", "llama-manager"):
        services[svc] = {
            "installed": LlamaServerManager.is_service_installed(svc),
            "enabled": LlamaServerManager.is_service_enabled(svc),
            "active": LlamaServerManager.is_service_active(svc),
        }
    return jsonify(services)


@app.route("/api/service/action", methods=["POST"])
def api_service_action():
    data = request.json or {}
    service = data.get("service", "llama-server")
    action = data.get("action")
    if not action:
        return jsonify({"ok": False, "error": "action is required"}), 400

    ok, msg = LlamaServerManager.service_action(service, action)
    return jsonify({"ok": ok, "message": msg})


@app.route("/api/service/install", methods=["POST"])
def api_service_install():
    data = request.json or {}
    model_path = data.get("model_path")
    params = data.get("params", config.get("default_params", {}))
    if not model_path:
        return jsonify({"ok": False, "error": "model_path is required"}), 400

    ok, msg = server_manager.install_service_env(model_path, params)
    return jsonify({"ok": ok, "message": msg})


@app.route("/api/chat", methods=["POST"])
def api_chat_proxy():
    """Proxy chat completions to the running llama-server."""
    port = server_manager.current_params.get(
        "port", config.get("llama_server_port", 8080)
    )
    data = request.json or {}

    try:
        r = requests.post(
            f"http://127.0.0.1:{port}/v1/chat/completions",
            json=data,
            timeout=300,
            stream=False,
        )
        return jsonify(r.json()), r.status_code
    except requests.ConnectionError:
        return jsonify({"error": "llama-server is not running or not reachable"}), 503
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ---------------------------------------------------------------------------
# SocketIO Events
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect():
    logger.info("WebSocket client connected")
    emit("connected", {"status": "ok"})
    # Push the current snapshot immediately so the dashboard isn't blank
    # while waiting for the first background emitter cycle (~1 s).
    with metrics_lock:
        data = dict(system_metrics)
    server_status = server_manager.get_status()
    llama_metrics = server_manager.parse_metrics() if server_status["running"] else {}
    health = server_manager.get_llama_health() if server_status["running"] else {}
    logger.debug(
        f"[WS] Pushing initial metrics snapshot to new client – "
        f"cpu_populated={bool(data.get('cpu'))} "
        f"mem_populated={bool(data.get('memory'))} "
        f"gpu_present={bool(data.get('gpu'))}"
    )
    emit("metrics_update", {
        "system": data,
        "server": server_status,
        "llama": llama_metrics,
        "health": health,
        "timestamp": time.time(),
    })


@socketio.on("disconnect")
def on_disconnect():
    logger.info("WebSocket client disconnected")


@socketio.on("request_metrics")
def on_request_metrics():
    """Client requests a metrics update."""
    with metrics_lock:
        data = dict(system_metrics)

    server_status = server_manager.get_status()
    llama_metrics = server_manager.parse_metrics() if server_status["running"] else {}
    health = server_manager.get_llama_health() if server_status["running"] else {}

    emit("metrics_update", {
        "system": data,
        "server": server_status,
        "llama": llama_metrics,
        "health": health,
        "timestamp": time.time(),
    })


# Background emit loop
def metrics_emitter():
    """Push metrics to all connected clients every ~1s."""
    logger.info("[WS] metrics_emitter background task started")
    _emit_count = 0
    while True:
        try:
            with metrics_lock:
                data = dict(system_metrics)

            server_status = server_manager.get_status()
            llama_metrics = server_manager.parse_metrics() if server_status["running"] else {}
            health = server_manager.get_llama_health() if server_status["running"] else {}

            socketio.emit("metrics_update", {
                "system": data,
                "server": server_status,
                "llama": llama_metrics,
                "health": health,
                "timestamp": time.time(),
            })

            _emit_count += 1
            # Periodic confirmation that data is flowing (every 30 s)
            if _emit_count % 30 == 0:
                logger.info(
                    f"[WS] metrics_emitter: {_emit_count} broadcasts so far – "
                    f"cpu={data.get('cpu', {}).get('percent', 'N/A')}% "
                    f"mem={data.get('memory', {}).get('percent', 'N/A')}% "
                    f"gpu_present={bool(data.get('gpu'))}"
                )
        except Exception as exc:
            logger.warning(f"[WS] metrics_emitter error: {exc}", exc_info=True)
        socketio.sleep(1)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def main():
    port = config.get("web_port", 8484)
    logger.info("=" * 60)
    logger.info("Starting LlamaServer Manager")
    logger.info(f"  Port        : {port}")
    logger.info(f"  Config file : {CONFIG_FILE}")
    logger.info(f"  Models dir  : {config.get('models_dir')}")
    logger.info(f"  llama-server: {config.get('llama_server_path')}")
    logger.info(f"  GPU type    : {config.get('gpu_type', 'unknown')}")
    logger.info(f"  NVIDIA NVML : {'enabled' if nvidia_available else 'disabled'}")
    logger.info("=" * 60)

    # Start background metrics emitter
    socketio.start_background_task(metrics_emitter)

    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=False,
        use_reloader=False,
        log_output=True,
    )


if __name__ == "__main__":
    main()