#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ─── Colors & Helpers ───────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; MAGENTA='\033[0;35m'
BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_INSTALL_DIR="/opt/llama-manager"
DEFAULT_MODELS_DIR="/opt/models"
DEFAULT_PORT=5000
LOG_FILE="/tmp/llama-manager-install.log"

step_num=0
total_steps=8

banner() {
    clear
    echo -e "${CYAN}${BOLD}"
    cat << 'EOF'
    ╔═══════════════════════════════════════════════════════════╗
    ║                                                           ║
    ║          🦙  Llama Server Manager — Installer             ║
    ║             Manage llama.cpp from your browser             ║
    ║                                                           ║
    ╚═══════════════════════════════════════════════════════════╝
EOF
    echo -e "${NC}"
}

info()    { echo -e "  ${BLUE}ℹ${NC}  $*"; }
ok()      { echo -e "  ${GREEN}✔${NC}  $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC}  $*"; }
fail()    { echo -e "  ${RED}✘${NC}  $*"; }
ask()     { echo -en "  ${MAGENTA}?${NC}  $* "; }
header()  { step_num=$((step_num+1)); echo -e "\n${BOLD}${CYAN}[$step_num/$total_steps]${NC} ${BOLD}$*${NC}\n"; }
run_log() { "$@" >> "$LOG_FILE" 2>&1; }
divider() { echo -e "${DIM}  ─────────────────────────────────────────────────────${NC}"; }

confirm() {
    local prompt="$1" default="${2:-y}"
    if [[ "$default" == "y" ]]; then
        ask "$prompt [Y/n]:"
        read -r ans; ans="${ans:-y}"
    else
        ask "$prompt [y/N]:"
        read -r ans; ans="${ans:-n}"
    fi
    [[ "${ans,,}" == "y" ]]
}

choose() {
    local prompt="$1"; shift
    local options=("$@")
    echo -e "  ${MAGENTA}?${NC}  $prompt"
    for i in "${!options[@]}"; do
        echo -e "     ${BOLD}$((i+1)))${NC} ${options[$i]}"
    done
    while true; do
        ask "Select [1-${#options[@]}]:"
        read -r choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#options[@]} )); then
            return $((choice-1))
        fi
        fail "Invalid selection."
    done
}

abort() { echo -e "\n${RED}${BOLD}Installation aborted.${NC} $*\n"; exit 1; }

# ─── Pre-flight ─────────────────────────────────────────────────────────────
banner

if [[ $EUID -ne 0 ]]; then
    warn "Not running as root. Will use sudo for privileged operations."
    SUDO="sudo"
    REAL_USER="$USER"
else
    SUDO=""
    REAL_USER="${SUDO_USER:-root}"
fi

echo -e "  ${DIM}Install log: $LOG_FILE${NC}"
> "$LOG_FILE"

# ─── Step 1: System Check ───────────────────────────────────────────────────
header "System Check"

# OS detection
if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS_NAME="${PRETTY_NAME:-$ID}"
    OS_ID="${ID:-unknown}"
else
    OS_NAME="Unknown"
    OS_ID="unknown"
fi

if [[ "$OS_ID" != "debian" && "$OS_ID" != "ubuntu" && "$OS_ID" != "linuxmint" && "$OS_ID" != "pop" ]]; then
    warn "Detected: $OS_NAME (not Debian/Ubuntu — some features may not work)"
    confirm "Continue anyway?" "y" || abort
else
    ok "OS: $OS_NAME"
fi

# Python check
PYTHON_CMD=""
for cmd in python3.12 python3.11 python3.10 python3; do
    if command -v "$cmd" &>/dev/null; then
        PY_VER=$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
        PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
        if (( PY_MAJOR == 3 && PY_MINOR >= 10 )); then
            PYTHON_CMD="$cmd"
            break
        fi
    fi
done

if [[ -z "$PYTHON_CMD" ]]; then
    fail "Python 3.10+ not found!"
    info "Install with: sudo apt install python3.11 python3.11-venv python3.11-dev"
    abort "Python 3.10+ is required."
fi
ok "Python: $($PYTHON_CMD --version 2>&1)"

# CPU info
CPU_CORES=$(nproc 2>/dev/null || echo "?")
CPU_MODEL=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo "Unknown")
ok "CPU: $CPU_MODEL ($CPU_CORES cores)"

# RAM
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "0")
TOTAL_RAM_GB=$(( TOTAL_RAM_KB / 1024 / 1024 ))
ok "RAM: ${TOTAL_RAM_GB} GB"

# ─── Step 2: GPU Detection ──────────────────────────────────────────────────
header "GPU Detection"

GPU_TYPE="none"
GPU_NAME=""
GPU_VRAM=""

if command -v nvidia-smi &>/dev/null; then
    GPU_INFO=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || true)
    if [[ -n "$GPU_INFO" ]]; then
        GPU_TYPE="nvidia"
        GPU_NAME=$(echo "$GPU_INFO" | head -1 | cut -d, -f1 | xargs)
        GPU_VRAM=$(echo "$GPU_INFO" | head -1 | cut -d, -f2 | xargs)
        ok "NVIDIA GPU: $GPU_NAME (${GPU_VRAM} MB VRAM)"
        GPU_COUNT=$(echo "$GPU_INFO" | wc -l)
        if (( GPU_COUNT > 1 )); then
            info "  Multi-GPU detected: $GPU_COUNT GPUs"
        fi
    fi
fi

if [[ "$GPU_TYPE" == "none" ]] && command -v rocm-smi &>/dev/null; then
    if rocm-smi --showproductname &>/dev/null 2>&1; then
        GPU_TYPE="amd"
        GPU_NAME=$(rocm-smi --showproductname 2>/dev/null | grep -i "card series" | head -1 | awk -F: '{print $2}' | xargs || echo "AMD GPU")
        ok "AMD GPU: $GPU_NAME (ROCm)"
    fi
fi

if [[ "$GPU_TYPE" == "none" ]]; then
    warn "No GPU detected — CPU-only mode will be used"
    info "GPU offloading (--n-gpu-layers) won't be available"
fi

# ─── Step 3: System Dependencies ────────────────────────────────────────────
header "System Dependencies"

PKGS_NEEDED=()
for pkg in python3-venv python3-pip git curl build-essential cmake; do
    if ! dpkg -l "$pkg" &>/dev/null 2>&1; then
        PKGS_NEEDED+=("$pkg")
    fi
done

if (( ${#PKGS_NEEDED[@]} > 0 )); then
    info "Missing packages: ${PKGS_NEEDED[*]}"
    if confirm "Install them now?" "y"; then
        info "Running apt update..."
        $SUDO apt-get update -qq >> "$LOG_FILE" 2>&1 || warn "apt update had issues (check log)"
        info "Installing: ${PKGS_NEEDED[*]}"
        $SUDO apt-get install -y -qq "${PKGS_NEEDED[@]}" >> "$LOG_FILE" 2>&1 || abort "Failed to install packages"
        ok "Dependencies installed"
    else
        warn "Skipping — some features may not work"
    fi
else
    ok "All system dependencies present"
fi

# ─── Step 4: llama-server Binary ────────────────────────────────────────────
header "llama-server Binary"

LLAMA_SERVER_PATH=""
for p in /usr/local/bin/llama-server /usr/bin/llama-server; do
    if [[ -x "$p" ]]; then
        LLAMA_SERVER_PATH="$p"
        break
    fi
done

if [[ -z "$LLAMA_SERVER_PATH" ]] && command -v llama-server &>/dev/null; then
    LLAMA_SERVER_PATH="$(command -v llama-server)"
fi

if [[ -n "$LLAMA_SERVER_PATH" ]]; then
    ok "Found: $LLAMA_SERVER_PATH"
    LLAMA_VER=$("$LLAMA_SERVER_PATH" --version 2>&1 | head -1 || echo "unknown")
    info "Version: $LLAMA_VER"
    if confirm "Use this binary?" "y"; then
        : # keep it
    else
        LLAMA_SERVER_PATH=""
    fi
fi

if [[ -z "$LLAMA_SERVER_PATH" ]]; then
    warn "llama-server not found"
    divider
    choose "How to proceed?" \
        "Build llama.cpp from source (recommended)" \
        "Enter path manually" \
        "Skip (configure later in WebUI)"
    BUILD_CHOICE=$?

    case $BUILD_CHOICE in
        0)  # Build from source
            BUILD_DIR="/tmp/llama-cpp-build-$$"
            info "Cloning llama.cpp into $BUILD_DIR..."
            git clone --depth 1 https://github.com/ggerganov/llama.cpp "$BUILD_DIR" >> "$LOG_FILE" 2>&1 || abort "Git clone failed"
            ok "Repository cloned"

            CMAKE_ARGS="-DLLAMA_CURL=ON"
            if [[ "$GPU_TYPE" == "nvidia" ]]; then
                choose "Build type:" "CPU only" "NVIDIA CUDA (recommended for your GPU)"
                if (( $? == 1 )); then
                    if ! command -v nvcc &>/dev/null; then
                        warn "CUDA toolkit not found. Install nvidia-cuda-toolkit first."
                        if confirm "Install nvidia-cuda-toolkit?" "y"; then
                            $SUDO apt-get install -y -qq nvidia-cuda-toolkit >> "$LOG_FILE" 2>&1 || warn "Failed to install CUDA toolkit"
                        fi
                    fi
                    CMAKE_ARGS+=" -DGGML_CUDA=ON"
                    info "Building with CUDA support..."
                fi
            elif [[ "$GPU_TYPE" == "amd" ]]; then
                choose "Build type:" "CPU only" "AMD ROCm (recommended for your GPU)"
                if (( $? == 1 )); then
                    CMAKE_ARGS+=" -DGGML_HIP=ON"
                    info "Building with ROCm/HIP support..."
                fi
            else
                info "Building CPU-only version..."
            fi

            cd "$BUILD_DIR"
            info "Configuring (cmake)..."
            cmake -B build $CMAKE_ARGS >> "$LOG_FILE" 2>&1 || abort "cmake configure failed (check $LOG_FILE)"
            info "Compiling (this may take several minutes)..."
            cmake --build build --config Release -j"$(nproc)" >> "$LOG_FILE" 2>&1 || abort "Build failed (check $LOG_FILE)"

            if [[ -f build/bin/llama-server ]]; then
                $SUDO cp build/bin/llama-server /usr/local/bin/llama-server
                $SUDO chmod +x /usr/local/bin/llama-server
                LLAMA_SERVER_PATH="/usr/local/bin/llama-server"
                ok "llama-server installed to $LLAMA_SERVER_PATH"
            else
                abort "Build succeeded but llama-server binary not found"
            fi

            cd "$SCRIPT_DIR"
            rm -rf "$BUILD_DIR"
            ;;
        1)  # Manual path
            ask "Enter full path to llama-server:"
            read -r LLAMA_SERVER_PATH
            if [[ ! -x "$LLAMA_SERVER_PATH" ]]; then
                warn "File not found or not executable: $LLAMA_SERVER_PATH"
                LLAMA_SERVER_PATH=""
            else
                ok "Using: $LLAMA_SERVER_PATH"
            fi
            ;;
        2)  # Skip
            info "Skipping — you can set the path later in the WebUI"
            ;;
    esac
fi

# ─── Step 5: Installation Directory ─────────────────────────────────────────
header "Installation Directory"

ask "Install to [${DEFAULT_INSTALL_DIR}]:"
read -r INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"

if [[ -d "$INSTALL_DIR" ]]; then
    warn "Directory $INSTALL_DIR already exists"
    if confirm "Overwrite app files? (config will be preserved)" "y"; then
        :
    else
        abort "Choose a different directory"
    fi
fi

$SUDO mkdir -p "$INSTALL_DIR/templates"
ok "Directory: $INSTALL_DIR"

# ─── Step 6: Models Directory ────────────────────────────────────────────────
header "Models Directory"

ask "Models directory [${DEFAULT_MODELS_DIR}]:"
read -r MODELS_DIR
MODELS_DIR="${MODELS_DIR:-$DEFAULT_MODELS_DIR}"

$SUDO mkdir -p "$MODELS_DIR"
ok "Models directory: $MODELS_DIR"

# Count existing models
MODEL_COUNT=$(find "$MODELS_DIR" -name "*.gguf" -o -name "*.bin" 2>/dev/null | wc -l)
if (( MODEL_COUNT > 0 )); then
    ok "Found $MODEL_COUNT model file(s)"
else
    info "No models found yet. Place .gguf files in $MODELS_DIR"
fi

# ─── Step 7: Python Environment ─────────────────────────────────────────────
header "Python Virtual Environment"

VENV_DIR="$INSTALL_DIR/venv"

info "Creating venv at $VENV_DIR..."
$SUDO "$PYTHON_CMD" -m venv "$VENV_DIR" >> "$LOG_FILE" 2>&1 || abort "Failed to create venv"
ok "Virtual environment created"

info "Installing Python dependencies..."
$SUDO "$VENV_DIR/bin/pip" install --upgrade pip >> "$LOG_FILE" 2>&1
$SUDO "$VENV_DIR/bin/pip" install \
    'flask>=3.0' \
    'flask-socketio>=5.3' \
    'simple-websocket>=1.0' \
    'psutil>=5.9' \
    'requests>=2.31' \
    >> "$LOG_FILE" 2>&1 || abort "Failed to install Python packages"
ok "Dependencies installed"

# ─── Copy Application Files ─────────────────────────────────────────────────
info "Copying application files..."

if [[ -f "$SCRIPT_DIR/app.py" ]]; then
    $SUDO cp "$SCRIPT_DIR/app.py" "$INSTALL_DIR/app.py"
else
    abort "app.py not found in $SCRIPT_DIR"
fi

if [[ -f "$SCRIPT_DIR/templates/index.html" ]]; then
    $SUDO cp "$SCRIPT_DIR/templates/index.html" "$INSTALL_DIR/templates/index.html"
else
    abort "templates/index.html not found in $SCRIPT_DIR"
fi

# Write initial config
CONFIG_FILE="$INSTALL_DIR/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
    $SUDO tee "$CONFIG_FILE" > /dev/null << EOCFG
{
  "llama_server_path": "${LLAMA_SERVER_PATH}",
  "models_dir": "${MODELS_DIR}",
  "selected_model": "",
  "host": "127.0.0.1",
  "port": 8080,
  "ctx_size": 4096,
  "threads": $(( $(nproc) > 1 ? $(nproc) - 1 : 1 )),
  "threads_batch": $(nproc),
  "n_gpu_layers": 0,
  "main_gpu": 0,
  "batch_size": 2048,
  "ubatch_size": 512,
  "flash_attn": false,
  "cache_type_k": "f16",
  "cache_type_v": "f16",
  "mlock": false,
  "no_mmap": false,
  "parallel": 1,
  "cont_batching": true,
  "embedding": false,
  "numa": "disabled",
  "rope_freq_base": 0,
  "rope_freq_scale": 0,
  "verbose": true,
  "extra_args": ""
}
EOCFG
    ok "Default config created"
else
    info "Existing config preserved"
fi

$SUDO chown -R "$REAL_USER":"$REAL_USER" "$INSTALL_DIR" 2>/dev/null || true
ok "Application files installed"

# ─── Step 8: Service Installation ────────────────────────────────────────────
header "Service Installation"

ask "Manager WebUI port [${DEFAULT_PORT}]:"
read -r MANAGER_PORT
MANAGER_PORT="${MANAGER_PORT:-$DEFAULT_PORT}"

choose "Install llama-manager as a systemd service?" \
    "Yes — enable start on boot" \
    "Yes — manual start only" \
    "No — I'll run it manually"
SVC_CHOICE=$?

if (( SVC_CHOICE < 2 )); then
    SVC_FILE="/etc/systemd/system/llama-manager.service"
    $SUDO tee "$SVC_FILE" > /dev/null << EOSVC
[Unit]
Description=Llama Server Manager WebUI
After=network.target

[Service]
Type=simple
User=${REAL_USER}
Group=${REAL_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${VENV_DIR}/bin/python ${INSTALL_DIR}/app.py --host 0.0.0.0 --port ${MANAGER_PORT}
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOSVC

    $SUDO systemctl daemon-reload
    if (( SVC_CHOICE == 0 )); then
        $SUDO systemctl enable llama-manager >> "$LOG_FILE" 2>&1
        ok "Service installed and enabled (start on boot)"
    else
        ok "Service installed (manual start)"
    fi

    if confirm "Start the manager now?" "y"; then
        $SUDO systemctl start llama-manager
        sleep 2
        if systemctl is-active --quiet llama-manager; then
            ok "Manager is running!"
        else
            warn "Service may still be starting — check: systemctl status llama-manager"
        fi
    fi
else
    info "Skipping service installation"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}"
cat << 'EOF'
  ╔═══════════════════════════════════════════════════════════╗
  ║               Installation Complete! 🎉                  ║
  ╚═══════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

echo -e "  ${BOLD}Installation:${NC}  $INSTALL_DIR"
echo -e "  ${BOLD}Models:${NC}        $MODELS_DIR"
echo -e "  ${BOLD}llama-server:${NC}  ${LLAMA_SERVER_PATH:-Not configured}"
echo -e "  ${BOLD}Python venv:${NC}   $VENV_DIR"
echo ""

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
echo -e "  ${GREEN}${BOLD}WebUI:${NC}  ${BOLD}http://${LOCAL_IP}:${MANAGER_PORT}${NC}"
echo -e "         http://localhost:${MANAGER_PORT}"
echo ""

divider
echo -e "  ${BOLD}Manual start:${NC}"
echo -e "    cd $INSTALL_DIR"
echo -e "    source venv/bin/activate"
echo -e "    python app.py --port $MANAGER_PORT"
echo ""
echo -e "  ${BOLD}Service commands:${NC}"
echo -e "    sudo systemctl start llama-manager"
echo -e "    sudo systemctl stop llama-manager"
echo -e "    sudo systemctl status llama-manager"
echo -e "    journalctl -u llama-manager -f"
divider
echo ""

echo -e "  ${DIM}Place your .gguf models in: ${MODELS_DIR}${NC}"
echo -e "  ${DIM}Full install log: ${LOG_FILE}${NC}"
echo ""