#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
bridge_dir="$(dirname -- "$script_dir")"
env_file="${CLAWBRIDGE_SERVICE_ENV_FILE:-$HOME/.config/clawbridge/coordinator.env}"
node_path="$(command -v node || true)"

if [ -z "$node_path" ]; then
  echo "Node.js is required to install the coordinator service." >&2
  exit 1
fi
if [ ! -r "$env_file" ]; then
  echo "Create a private coordinator environment file first: $env_file" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    plist_dir="$HOME/Library/LaunchAgents"
    plist="$plist_dir/com.clawbridge.coordinator.plist"
    mkdir -p "$plist_dir"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.clawbridge.coordinator</string>
  <key>ProgramArguments</key><array><string>$script_dir/ssh-coordinator.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>CLAWBRIDGE_SERVICE_ENV_FILE</key><string>$env_file</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/clawbridge-coordinator.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/clawbridge-coordinator.error.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo "Installed launchd service: $plist"
    ;;
  Linux)
    unit_dir="$HOME/.config/systemd/user"
    unit="$unit_dir/clawbridge-coordinator.service"
    mkdir -p "$unit_dir"
    cat > "$unit" <<EOF
[Unit]
Description=ClawBridge coordinator
After=network-online.target

[Service]
Type=simple
Environment=CLAWBRIDGE_SERVICE_ENV_FILE=$env_file
ExecStart=$script_dir/ssh-coordinator.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now clawbridge-coordinator.service
    echo "Installed systemd user service: $unit"
    ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac
