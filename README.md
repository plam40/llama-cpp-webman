# LlamaServer Manager

A web-based management interface for [llama.cpp](https://github.com/ggerganov/llama.cpp). Easily configure and run llama-server instances with a simple web UI.

## Features

- Web-based dashboard for managing llama-server
- Model selection and upload
- Interactive parameter configuration
- Chat interface with real-time responses
- Real-time server metrics and logging
- Integrated llama.cpp server management

## Requirements

- Debian/Ubuntu (or compatible)
- Python 3.10+
- 2GB+ RAM
- Internet connection for initial setup

## Installation

Run the interactive installer:

```bash
sudo bash install.sh
```

The installer will:
- Install system dependencies
- Set up Python virtual environment
- Configure llama.cpp server
- Create systemd service
- Set up logging

## Usage

### Start the service

```bash
sudo systemctl start llama-manager
```

### Access the web interface

Open your browser to:
```
http://localhost:8484
```

### View logs

```bash
sudo journalctl -u llama-manager -f
```

## Configuration

Configuration is stored in `/opt/llama-manager/config/config.json`.

Key settings:
- `port`: Web interface port (default: 8484)
- `llama_server_port`: llama-server port (default: 8080)
- `models_dir`: Directory for downloaded models
- `log_level`: Logging level (debug, info, warning, error)

## Architecture

- **Backend**: Python Flask with SocketIO for real-time updates
- **Frontend**: Vanilla JavaScript with real-time metrics display
- **Server**: gevent async server with background threading
- **Integration**: Manages llama.cpp subprocess

## Troubleshooting

If the service fails to start:

```bash
# Check logs
sudo journalctl -u llama-manager -n 50

# Check if port is in use
sudo lsof -i :8484

# Verify installation
ls -la /opt/llama-manager
```

## License

See LICENSE file in repository.
