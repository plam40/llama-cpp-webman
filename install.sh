#!/bin/bash
#===============================================================================
# LlamaServer Manager - Interactive Installer
# Target: Debian with Python 3.10+
#===============================================================================

set -e

# Colors and formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Unicode symbols
CHECK="✓"
CROSS="✗"
ARROW="→"
GEAR="⚙"
ROCKET="🚀"
PACKAGE="📦"
WRENCH="🔧"
SHIELD="🛡"
CHART="📊"
GLOBE="🌐"

# Configuration defaults
INSTALL_DIR="/opt/llama-manager"
MODELS_DIR="/opt/models"
VENV_DIR="${INSTALL_DIR}/venv"
CONFIG_DIR="${INSTALL_DIR}/config"
LOG_DIR="/var/log/llama-manager"
SERVICE_USER="llama"
WEB_PORT=8484
LLAMA_SERVER_PORT=8080
LLAMA_CPP_DIR="/opt/llama.cpp"

# State tracking
ERRORS=()
WARNINGS=()

#-------------------------------------------------------------------------------
# Utility Functions
#-------------------------------------------------------------------------------

print_banner() {
    clear
    echo -e "${CYAN}"
    cat << 'EOF'
    ╔══════════════════════════════════════════════════════════════╗
    ║                                                              ║
    ║   🦙  LlamaServer Manager - Interactive Installer  🦙       ║
    ║                                                              ║
    ║   Manage local llama-server with a beautiful WebUI           ║
    ║   Configure, optimize, monitor, and control your LLM        ║
    ║                                                              ║
    ╚══════════════════════════════════════════════════════════════╝
EOF
    echo -e "${NC}"
    echo -e "${DIM}    Version 1.0.0 | Target: Debian | Python 3.10+${NC}"
    echo ""
}

log_info() {
    echo -e "  ${BLUE}${ARROW}${NC} $1"
}

log_success() {
    echo -e "  ${GREEN}${CHECK}${NC} $1"
}

log_warning() {
    echo -e "  ${YELLOW}⚠${NC} $1"
    WARNINGS+=("$1")
}

log_error() {
    echo -e "  ${RED}${CROSS}${NC} $1"
    ERRORS+=("$1")
}

log_step() {
    echo ""
    echo -e "${BOLD}${MAGENTA}  ${GEAR} $1${NC}"
    echo -e "${DIM}  $(printf '%.0s─' {1..58})${NC}"
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-y}"
    local yn_hint
    if [[ "$default" == "y" ]]; then
        yn_hint="[Y/n]"
    else
        yn_hint="[y/N]"
    fi
    
    while true; do
        echo -ne "  ${CYAN}?${NC} ${prompt} ${DIM}${yn_hint}${NC} "
        read -r answer
        answer="${answer:-$default}"
        case "$answer" in
            [Yy]*) return 0 ;;
            [Nn]*) return 1 ;;
            *) echo -e "    ${DIM}Please answer yes or no${NC}" ;;
        esac
    done
}

prompt_input() {
    local prompt="$1"
    local default="$2"
    local result
    
    if [[ -n "$default" ]]; then
        echo -ne "  ${CYAN}?${NC} ${prompt} ${DIM}[${default}]${NC}: "
    else
        echo -ne "  ${CYAN}?${NC} ${prompt}: "
    fi
    read -r result
    echo "${result:-$default}"
}

prompt_select() {
    local prompt="$1"
    shift
    local options=("$@")
    
    echo -e "  ${CYAN}?${NC} ${prompt}"
    for i in "${!options[@]}"; do
        echo -e "    ${DIM}$((i+1)))${NC} ${options[$i]}"
    done
    
    while true; do
        echo -ne "    ${CYAN}→${NC} Select option: "
        read -r choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#options[@]} )); then
            echo "${options[$((choice-1))]}"
            return 0
        fi
        echo -e "    ${DIM}Invalid selection, try again${NC}"
    done
}

spinner() {
    local pid=$1
    local message="$2"
    local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local i=0
    
    while kill -0 "$pid" 2>/dev/null; do
        printf "\r  ${CYAN}${spin:i++%${#spin}:1}${NC} ${message}"
        sleep 0.1
    done
    
    wait "$pid"
    local exit_code=$?
    printf "\r"
    
    if [[ $exit_code -eq 0 ]]; then
        log_success "$message"
    else
        log_error "$message (failed with exit code $exit_code)"
    fi
    
    return $exit_code
}

run_with_spinner() {
    local message="$1"
    shift
    
    "$@" &>/tmp/llama_install.log &
    local pid=$!
    spinner "$pid" "$message"
    return $?
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        echo -e "${RED}  ${CROSS} This installer must be run as root (use sudo)${NC}"
        echo ""
        echo -e "  Usage: ${BOLD}sudo bash install.sh${NC}"
        exit 1
    fi
}

#-------------------------------------------------------------------------------
# System Detection & Checks
#-------------------------------------------------------------------------------

detect_system() {
    log_step "Detecting System Configuration"
    
    # OS Detection
    if [[ -f /etc/os-release ]]; then
        source /etc/os-release
        OS_NAME="$NAME"
        OS_VERSION="$VERSION_ID"
        log_success "OS: ${OS_NAME} ${OS_VERSION}"
    else
        log_error "Cannot detect OS - /etc/os-release not found"
        exit 1
    fi
    
    # Check Debian-based
    if ! command -v apt-get &>/dev/null; then
        log_error "This installer requires a Debian-based system with apt-get"
        exit 1
    fi
    
    # CPU Detection
    CPU_MODEL=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)
    CPU_CORES=$(nproc)
    CPU_THREADS=$(grep -c processor /proc/cpuinfo)
    log_success "CPU: ${CPU_MODEL} (${CPU_CORES} cores, ${CPU_THREADS} threads)"
    
    # Memory Detection
    TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    TOTAL_RAM_GB=$(echo "scale=1; $TOTAL_RAM_KB / 1048576" | bc)
    log_success "RAM: ${TOTAL_RAM_GB} GB"
    
    # GPU Detection
    GPU_DETECTED=false
    GPU_TYPE="none"
    GPU_NAME="None"
    
    if command -v nvidia-smi &>/dev/null; then
        GPU_DETECTED=true
        GPU_TYPE="nvidia"
        GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1 | xargs)
        GPU_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -1 | xargs)
        CUDA_VERSION=$(nvidia-smi | grep "CUDA Version" | awk '{print $9}')
        log_success "GPU: ${GPU_NAME} (${GPU_VRAM}, CUDA ${CUDA_VERSION})"
    elif [[ -d /sys/class/drm ]] && ls /sys/class/drm/card*/device/vendor 2>/dev/null | head -1 | xargs cat 2>/dev/null | grep -q "0x1002"; then
        GPU_DETECTED=true
        GPU_TYPE="amd"
        GPU_NAME="AMD GPU detected"
        log_success "GPU: ${GPU_NAME} (ROCm support may be available)"
    else
        log_warning "No dedicated GPU detected - CPU-only mode"
    fi
    
    # Python Detection
    PYTHON_CMD=""
    for cmd in python3.12 python3.11 python3.10 python3; do
        if command -v "$cmd" &>/dev/null; then
            PY_VERSION=$("$cmd" --version 2>&1 | awk '{print $2}')
            PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
            PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
            if (( PY_MAJOR == 3 && PY_MINOR >= 10 )); then
                PYTHON_CMD="$cmd"
                break
            fi
        fi
    done
    
    if [[ -n "$PYTHON_CMD" ]]; then
        log_success "Python: $($PYTHON_CMD --version 2>&1)"
    else
        log_warning "Python 3.10+ not found - will install"
    fi
    
    # Check for existing llama-server
    LLAMA_SERVER_PATH=""
    if command -v llama-server &>/dev/null; then
        LLAMA_SERVER_PATH=$(which llama-server)
        log_success "llama-server found: ${LLAMA_SERVER_PATH}"
    elif [[ -f "${LLAMA_CPP_DIR}/build/bin/llama-server" ]]; then
        LLAMA_SERVER_PATH="${LLAMA_CPP_DIR}/build/bin/llama-server"
        log_success "llama-server found: ${LLAMA_SERVER_PATH}"
    elif [[ -f "/usr/local/bin/llama-server" ]]; then
        LLAMA_SERVER_PATH="/usr/local/bin/llama-server"
        log_success "llama-server found: ${LLAMA_SERVER_PATH}"
    else
        log_warning "llama-server not found - will offer to build from source"
    fi
    
    # Check for existing models
    if [[ -d "$MODELS_DIR" ]]; then
        MODEL_COUNT=$(find "$MODELS_DIR" -name "*.gguf" 2>/dev/null | wc -l)
        log_success "Models directory: ${MODELS_DIR} (${MODEL_COUNT} .gguf files found)"
    else
        log_warning "Models directory ${MODELS_DIR} does not exist - will create"
        MODEL_COUNT=0
    fi
    
    # Disk space
    DISK_AVAIL=$(df -BG "${INSTALL_DIR%/*}" 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'G')
    log_success "Available disk space: ${DISK_AVAIL}G"
}

#-------------------------------------------------------------------------------
# Interactive Configuration
#-------------------------------------------------------------------------------

configure_installation() {
    log_step "Installation Configuration"
    
    echo ""
    echo -e "  ${DIM}Configure the installation paths and options.${NC}"
    echo -e "  ${DIM}Press Enter to accept defaults shown in brackets.${NC}"
    echo ""
    
    # Install directory
    INSTALL_DIR=$(prompt_input "Installation directory" "$INSTALL_DIR")
    
    # Models directory
    MODELS_DIR=$(prompt_input "Models directory (GGUF files)" "$MODELS_DIR")
    
    # Web UI port
    WEB_PORT=$(prompt_input "Web UI port" "$WEB_PORT")
    
    # Llama server port
    LLAMA_SERVER_PORT=$(prompt_input "llama-server port" "$LLAMA_SERVER_PORT")
    
    # Build llama.cpp if not found
    BUILD_LLAMA=false
    if [[ -z "$LLAMA_SERVER_PATH" ]]; then
        echo ""
        if prompt_yes_no "llama-server not found. Build llama.cpp from source?" "y"; then
            BUILD_LLAMA=true
            
            if [[ "$GPU_TYPE" == "nvidia" ]]; then
                if prompt_yes_no "Enable CUDA support for GPU acceleration?" "y"; then
                    BUILD_CUDA=true
                else
                    BUILD_CUDA=false
                fi
            else
                BUILD_CUDA=false
            fi
        else
            LLAMA_SERVER_PATH=$(prompt_input "Enter path to llama-server binary" "/usr/local/bin/llama-server")
            if [[ ! -f "$LLAMA_SERVER_PATH" ]]; then
                log_error "llama-server not found at specified path"
                log_warning "You can install it later and update the configuration"
            fi
        fi
    fi
    
    # Service user
    echo ""
    if prompt_yes_no "Create dedicated service user '${SERVICE_USER}'?" "y"; then
        CREATE_USER=true
    else
        CREATE_USER=false
        SERVICE_USER=$(prompt_input "Run as user" "$(whoami)")
    fi
    
    # Install as systemd service
    echo ""
    if prompt_yes_no "Install as systemd service (auto-start on boot)?" "y"; then
        INSTALL_SERVICE=true
    else
        INSTALL_SERVICE=false
    fi
    
    # Summary
    echo ""
    log_step "Installation Summary"
    echo ""
    echo -e "  ${WHITE}Installation Directory:${NC}  ${INSTALL_DIR}"
    echo -e "  ${WHITE}Models Directory:${NC}        ${MODELS_DIR}"
    echo -e "  ${WHITE}Virtual Environment:${NC}     ${VENV_DIR}"
    echo -e "  ${WHITE}Web UI Port:${NC}             ${WEB_PORT}"
    echo -e "  ${WHITE}llama-server Port:${NC}       ${LLAMA_SERVER_PORT}"
    echo -e "  ${WHITE}Service User:${NC}            ${SERVICE_USER}"
    echo -e "  ${WHITE}Build llama.cpp:${NC}         ${BUILD_LLAMA}"
    [[ "$BUILD_LLAMA" == true ]] && echo -e "  ${WHITE}CUDA Support:${NC}            ${BUILD_CUDA:-false}"
    echo -e "  ${WHITE}Install Service:${NC}         ${INSTALL_SERVICE}"
    echo -e "  ${WHITE}llama-server Path:${NC}       ${LLAMA_SERVER_PATH:-'will be built'}"
    echo ""
    
    if ! prompt_yes_no "Proceed with installation?" "y"; then
        echo -e "\n  ${YELLOW}Installation cancelled.${NC}\n"
        exit 0
    fi
}

#-------------------------------------------------------------------------------
# Installation Steps
#-------------------------------------------------------------------------------

install_dependencies() {
    log_step "Installing System Dependencies"
    
    run_with_spinner "Updating package lists" apt-get update -qq
    
    PACKAGES=(
        build-essential
        cmake
        git
        curl
        wget
        pkg-config
        python3-dev
        python3-venv
        python3-pip
        libcurl4-openssl-dev
        lm-sensors
        pciutils
        bc
    )
    
    if [[ -z "$PYTHON_CMD" ]]; then
        PACKAGES+=(python3.11 python3.11-venv python3.11-dev)
    fi
    
    if [[ "$BUILD_CUDA" == true ]]; then
        PACKAGES+=(nvidia-cuda-toolkit)
    fi
    
    run_with_spinner "Installing packages: ${#PACKAGES[@]} packages" \
        apt-get install -y -qq "${PACKAGES[@]}"
    
    # Re-detect Python after install
    if [[ -z "$PYTHON_CMD" ]]; then
        for cmd in python3.12 python3.11 python3.10 python3; do
            if command -v "$cmd" &>/dev/null; then
                PY_VERSION=$("$cmd" --version 2>&1 | awk '{print $2}')
                PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
                PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
                if (( PY_MAJOR == 3 && PY_MINOR >= 10 )); then
                    PYTHON_CMD="$cmd"
                    break
                fi
            fi
        done
    fi
    
    if [[ -z "$PYTHON_CMD" ]]; then
        log_error "Failed to find Python 3.10+ after installation"
        exit 1
    fi
    
    log_success "Python command: $PYTHON_CMD ($($PYTHON_CMD --version 2>&1))"
}

build_llama_cpp() {
    if [[ "$BUILD_LLAMA" != true ]]; then
        return 0
    fi
    
    log_step "Building llama.cpp from Source"
    
    if [[ -d "$LLAMA_CPP_DIR" ]]; then
        log_info "Existing llama.cpp directory found, updating..."
        cd "$LLAMA_CPP_DIR"
        run_with_spinner "Pulling latest changes" git pull
    else
        run_with_spinner "Cloning llama.cpp repository" \
            git clone https://github.com/ggerganov/llama.cpp.git "$LLAMA_CPP_DIR"
        cd "$LLAMA_CPP_DIR"
    fi
    
    mkdir -p build && cd build
    
    CMAKE_ARGS="-DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=ON"
    
    if [[ "$BUILD_CUDA" == true ]]; then
        CMAKE_ARGS="$CMAKE_ARGS -DGGML_CUDA=ON"
        log_info "Building with CUDA support"
    fi
    
    run_with_spinner "Configuring build (cmake)" cmake .. $CMAKE_ARGS
    
    MAKE_JOBS=$((CPU_THREADS > 1 ? CPU_THREADS - 1 : 1))
    log_info "Building with ${MAKE_JOBS} parallel jobs..."
    run_with_spinner "Compiling llama.cpp (this may take several minutes)" \
        cmake --build . --config Release -j "$MAKE_JOBS"
    
    if [[ -f "bin/llama-server" ]]; then
        LLAMA_SERVER_PATH="${LLAMA_CPP_DIR}/build/bin/llama-server"
        log_success "llama-server built successfully: ${LLAMA_SERVER_PATH}"
        
        # Create symlink
        ln -sf "$LLAMA_SERVER_PATH" /usr/local/bin/llama-server
        log_success "Symlinked to /usr/local/bin/llama-server"
    else
        log_error "Build completed but llama-server binary not found"
        exit 1
    fi
}

create_directories() {
    log_step "Creating Directory Structure"
    
    dirs=(
        "$INSTALL_DIR"
        "$INSTALL_DIR/app"
        "$INSTALL_DIR/app/static"
        "$INSTALL_DIR/app/static/css"
        "$INSTALL_DIR/app/static/js"
        "$INSTALL_DIR/app/templates"
        "$CONFIG_DIR"
        "$LOG_DIR"
        "$MODELS_DIR"
    )
    
    for dir in "${dirs[@]}"; do
        mkdir -p "$dir"
        log_success "Created: ${dir}"
    done
}

create_service_user() {
    if [[ "$CREATE_USER" != true ]]; then
        return 0
    fi
    
    log_step "Creating Service User"
    
    if id "$SERVICE_USER" &>/dev/null; then
        log_info "User '${SERVICE_USER}' already exists"
    else
        useradd -r -s /bin/false -d "$INSTALL_DIR" -m "$SERVICE_USER" 2>/dev/null || true
        log_success "Created system user: ${SERVICE_USER}"
    fi
    
    # Add to video group for GPU access
    if [[ "$GPU_TYPE" == "nvidia" ]]; then
        usermod -aG video "$SERVICE_USER" 2>/dev/null || true
        log_success "Added ${SERVICE_USER} to video group"
    fi
}

setup_virtualenv() {
    log_step "Setting Up Python Virtual Environment"
    
    if [[ -d "$VENV_DIR" ]]; then
        log_info "Existing venv found, recreating..."
        rm -rf "$VENV_DIR"
    fi
    
    run_with_spinner "Creating virtual environment" \
        $PYTHON_CMD -m venv "$VENV_DIR"
    
    log_success "Virtual environment created at ${VENV_DIR}"
    
    # Activate and install packages
    source "${VENV_DIR}/bin/activate"
    
    run_with_spinner "Upgrading pip" \
        pip install --upgrade pip setuptools wheel
    
    # Create requirements file
    cat > "${INSTALL_DIR}/requirements.txt" << 'REQUIREMENTS'
flask>=3.0.0
flask-socketio>=5.3.0
gevent>=23.0.0
gevent-websocket>=0.10.1
psutil>=5.9.0
requests>=2.31.0
pynvml>=11.5.0;sys_platform=='linux'
py-cpuinfo>=9.0.0
REQUIREMENTS
    
    run_with_spinner "Installing Python dependencies" \
        pip install -r "${INSTALL_DIR}/requirements.txt"
    
    deactivate
    log_success "Python dependencies installed"
}

write_config() {
    log_step "Writing Configuration"
    
    cat > "${CONFIG_DIR}/config.json" << CONFIGJSON
{
    "install_dir": "${INSTALL_DIR}",
    "models_dir": "${MODELS_DIR}",
    "log_dir": "${LOG_DIR}",
    "web_port": ${WEB_PORT},
    "llama_server_port": ${LLAMA_SERVER_PORT},
    "llama_server_path": "${LLAMA_SERVER_PATH}",
    "service_user": "${SERVICE_USER}",
    "gpu_type": "${GPU_TYPE}",
    "gpu_name": "${GPU_NAME}",
    "cpu_cores": ${CPU_CORES},
    "cpu_threads": ${CPU_THREADS},
    "total_ram_gb": ${TOTAL_RAM_GB},
    "default_params": {
        "ctx_size": 4096,
        "n_predict": -1,
        "threads": $((CPU_THREADS / 2)),
        "threads_batch": ${CPU_THREADS},
        "n_gpu_layers": 0,
        "flash_attn": false,
        "mlock": false,
        "mmap": true,
        "cache_type_k": "f16",
        "cache_type_v": "f16",
        "batch_size": 2048,
        "ubatch_size": 512,
        "cont_batching": true,
        "host": "0.0.0.0",
        "port": ${LLAMA_SERVER_PORT},
        "parallel": 1,
        "temp": 0.7,
        "top_k": 40,
        "top_p": 0.95,
        "repeat_penalty": 1.1,
        "verbose": true
    }
}
CONFIGJSON
    
    log_success "Configuration written to ${CONFIG_DIR}/config.json"
}

install_systemd_services() {
    if [[ "$INSTALL_SERVICE" != true ]]; then
        return 0
    fi
    
    log_step "Installing Systemd Services"
    
    # LlamaServer Manager Web UI service
    cat > /etc/systemd/system/llama-manager.service << SERVICEEOF
[Unit]
Description=LlamaServer Manager Web UI
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${INSTALL_DIR}
Environment=PATH=${VENV_DIR}/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${VENV_DIR}/bin/python ${INSTALL_DIR}/app/main.py
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=llama-manager

[Install]
WantedBy=multi-user.target
SERVICEEOF
    
    log_success "Created llama-manager.service"
    
    # llama-server service (will be managed by the app)
    cat > /etc/systemd/system/llama-server.service << SERVEREOF
[Unit]
Description=llama.cpp Server
After=network.target
Wants=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${CONFIG_DIR}/llama-server.env
ExecStart=${LLAMA_SERVER_PATH}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=llama-server
LimitNOFILE=65536
LimitMEMLOCK=infinity

[Install]
WantedBy=multi-user.target
SERVEREOF
    
    log_success "Created llama-server.service"
    
    # Create empty env file
    touch "${CONFIG_DIR}/llama-server.env"
    
    run_with_spinner "Reloading systemd daemon" systemctl daemon-reload
    
    if prompt_yes_no "Enable llama-manager to start on boot?" "y"; then
        systemctl enable llama-manager.service
        log_success "llama-manager enabled for auto-start"
    fi
}

set_permissions() {
    log_step "Setting Permissions"
    
    chown -R root:root "$INSTALL_DIR"
    chmod -R 755 "$INSTALL_DIR"
    
    if [[ "$CREATE_USER" == true ]]; then
        chown -R "${SERVICE_USER}:${SERVICE_USER}" "$MODELS_DIR" 2>/dev/null || true
        chown -R "${SERVICE_USER}:${SERVICE_USER}" "$LOG_DIR"
    fi
    
    chmod -R 755 "$MODELS_DIR"
    chmod -R 755 "$LOG_DIR"
    
    log_success "Permissions configured"
}

print_completion() {
    echo ""
    echo -e "${GREEN}"
    cat << 'EOF'
    ╔══════════════════════════════════════════════════════════════╗
    ║                                                              ║
    ║   🎉  Installation Complete!  🎉                             ║
    ║                                                              ║
    ╚══════════════════════════════════════════════════════════════╝
EOF
    echo -e "${NC}"
    
    echo -e "  ${WHITE}${BOLD}Quick Start:${NC}"
    echo ""
    
    if [[ "$INSTALL_SERVICE" == true ]]; then
        echo -e "  ${GREEN}${ARROW}${NC} Start the manager:  ${BOLD}sudo systemctl start llama-manager${NC}"
        echo -e "  ${GREEN}${ARROW}${NC} Check status:        ${BOLD}sudo systemctl status llama-manager${NC}"
    fi
    
    echo -e "  ${GREEN}${ARROW}${NC} Start manually:      ${BOLD}cd ${INSTALL_DIR} && sudo ${VENV_DIR}/bin/python app/main.py${NC}"
    echo -e "  ${GREEN}${ARROW}${NC} Web UI:              ${BOLD}http://localhost:${WEB_PORT}${NC}"
    echo ""
    echo -e "  ${WHITE}${BOLD}Directories:${NC}"
    echo -e "  ${DIM}  App:     ${INSTALL_DIR}${NC}"
    echo -e "  ${DIM}  Models:  ${MODELS_DIR}${NC}"
    echo -e "  ${DIM}  Config:  ${CONFIG_DIR}${NC}"
    echo -e "  ${DIM}  Logs:    ${LOG_DIR}${NC}"
    echo ""
    
    if [[ ${#WARNINGS[@]} -gt 0 ]]; then
        echo -e "  ${YELLOW}${BOLD}Warnings:${NC}"
        for w in "${WARNINGS[@]}"; do
            echo -e "  ${YELLOW}  ⚠ ${w}${NC}"
        done
        echo ""
    fi
    
    echo -e "  ${DIM}Place your GGUF model files in ${MODELS_DIR}${NC}"
    echo -e "  ${DIM}Then open the Web UI to configure and start llama-server${NC}"
    echo ""
    
    if prompt_yes_no "Start llama-manager now?" "y"; then
        if [[ "$INSTALL_SERVICE" == true ]]; then
            systemctl start llama-manager
            sleep 2
            if systemctl is-active --quiet llama-manager; then
                log_success "llama-manager is running!"
                echo -e "\n  ${ROCKET} Open ${BOLD}http://localhost:${WEB_PORT}${NC} in your browser\n"
            else
                log_error "Failed to start. Check: journalctl -u llama-manager -f"
            fi
        else
            echo -e "\n  Starting in foreground...\n"
            cd "$INSTALL_DIR"
            "${VENV_DIR}/bin/python" app/main.py
        fi
    fi
}

#-------------------------------------------------------------------------------
# Main Installation Flow
#-------------------------------------------------------------------------------

main() {
    print_banner
    check_root
    
    echo -e "  ${WHITE}Welcome to the LlamaServer Manager installer!${NC}"
    echo -e "  ${DIM}This will set up a web-based management interface for llama-server.${NC}"
    echo ""
    
    if ! prompt_yes_no "Ready to begin system detection?" "y"; then
        echo -e "\n  Goodbye!\n"
        exit 0
    fi
    
    detect_system
    configure_installation
    install_dependencies
    build_llama_cpp
    create_directories
    create_service_user
    setup_virtualenv
    write_config
    
    # Write the application files
    log_step "Installing Application Files"
    log_info "Application files will be written to ${INSTALL_DIR}/app/"
    
    # The Python app files are written by a companion script or are expected
    # to be in the same directory as install.sh
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    if [[ -f "${SCRIPT_DIR}/app/main.py" ]]; then
        cp -r "${SCRIPT_DIR}/app/"* "${INSTALL_DIR}/app/"
        log_success "Application files copied from ${SCRIPT_DIR}/app/"
    else
        log_info "Application files should be placed in ${INSTALL_DIR}/app/"
        log_warning "Copy the app/ directory contents to ${INSTALL_DIR}/app/"
    fi
    
    install_systemd_services
    set_permissions
    print_completion
}

# Handle command line arguments
case "${1:-}" in
    --uninstall)
        print_banner
        check_root
        log_step "Uninstalling LlamaServer Manager"
        
        systemctl stop llama-manager 2>/dev/null || true
        systemctl stop llama-server 2>/dev/null || true
        systemctl disable llama-manager 2>/dev/null || true
        systemctl disable llama-server 2>/dev/null || true
        rm -f /etc/systemd/system/llama-manager.service
        rm -f /etc/systemd/system/llama-server.service
        systemctl daemon-reload
        
        if prompt_yes_no "Remove installation directory ${INSTALL_DIR}?" "n"; then
            rm -rf "$INSTALL_DIR"
            log_success "Removed ${INSTALL_DIR}"
        fi
        
        if prompt_yes_no "Remove log directory ${LOG_DIR}?" "n"; then
            rm -rf "$LOG_DIR"
            log_success "Removed ${LOG_DIR}"
        fi
        
        log_success "Uninstallation complete"
        echo ""
        ;;
    --help|-h)
        print_banner
        echo -e "  ${WHITE}Usage:${NC}"
        echo -e "    sudo bash install.sh              ${DIM}# Interactive installation${NC}"
        echo -e "    sudo bash install.sh --uninstall  ${DIM}# Remove installation${NC}"
        echo -e "    sudo bash install.sh --help       ${DIM}# Show this help${NC}"
        echo ""
        ;;
    *)
        main
        ;;
esac