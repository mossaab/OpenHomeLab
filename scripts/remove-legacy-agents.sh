#!/usr/bin/env bash
set -u

LEGACY_UNITS="tahakom-agent netcontrol-agent"
LEGACY_BINS="/usr/local/bin/tahakom-agent /usr/local/bin/netcontrol-agent"
NEW_AGENT_BIN=/usr/local/bin/openhomelab-agent
NEW_AGENT_UNIT=/etc/systemd/system/openhomelab-agent.service

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must run as root (sudo $0)" >&2
  exit 1
fi

removed=0
for unit in $LEGACY_UNITS; do
  if [ -f "/etc/systemd/system/$unit.service" ] || systemctl list-unit-files 2>/dev/null | grep -q "^$unit\.service"; then
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$unit.service"
    echo "removed unit: $unit.service"
    removed=1
  fi
done
if [ "$removed" = 1 ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
fi

for bin in $LEGACY_BINS; do
  pkill -f "$bin" >/dev/null 2>&1 || true
  if [ -e "$bin" ]; then
    rm -f "$bin"
    echo "removed binary: $bin"
  fi
done

for dir in /etc/tahakom /etc/netcontrol; do
  if [ -d "$dir" ]; then
    rm -rf "$dir"
    echo "removed config dir: $dir"
  fi
done

if [ ! -e "$NEW_AGENT_BIN" ] && [ ! -f "$NEW_AGENT_UNIT" ]; then
  echo "WARNING: the current agent ($NEW_AGENT_BIN) was not found on this machine." >&2
else
  echo "current agent intact: $NEW_AGENT_BIN"
fi

echo "Done. Legacy agents removed."
