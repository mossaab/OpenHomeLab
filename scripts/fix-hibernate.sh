#!/usr/bin/env bash
set -euo pipefail

SWAP_FILE=/swap.img
GRUB_DEFAULT=/etc/default/grub

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must be run as root" >&2
  exit 1
fi

mem_kb=$(awk '/^MemTotal/{print $2}' /proc/meminfo)
swap_kb=$(awk '/^SwapTotal/{print $2}' /proc/meminfo)
[ -z "$swap_kb" ] && swap_kb=0

if [ -n "$mem_kb" ] && [ "$swap_kb" -ge "$mem_kb" ]; then
  echo "Swap already sufficient (swap ${swap_kb} KB >= mem ${mem_kb} KB), skipping swap setup."
else
  target_mb=$(( (mem_kb + 1023) / 1024 ))
  target_gb=1
  while [ "$target_mb" -gt $(( target_gb * 1024 )) ]; do
    target_gb=$(( target_gb * 2 ))
  done

  if swapon --show --noheadings | awk '{print $1}' | grep -qx "$SWAP_FILE"; then
    swapoff "$SWAP_FILE"
  fi
  rm -f "$SWAP_FILE"
  echo "Creating ${target_gb}G swap file at ${SWAP_FILE} (RAM is ~$(( mem_kb / 1024 )) MB)..."
  if ! fallocate -l "${target_gb}G" "$SWAP_FILE" 2>/dev/null; then
    dd if=/dev/zero of="$SWAP_FILE" bs=1M count=$(( target_gb * 1024 )) status=none
  fi
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE" >/dev/null
  swapon "$SWAP_FILE"

  if awk -v f="$SWAP_FILE" '$1 == f {found=1} END {exit found ? 0 : 1}' /etc/fstab; then
    tmp=$(mktemp)
    awk -v l="${SWAP_FILE} none swap sw 0 0" -v f="$SWAP_FILE" '$1 == f {print l; next} {print}' /etc/fstab > "$tmp"
    mv "$tmp" /etc/fstab
  else
    echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
  fi
fi

if [ -f "$GRUB_DEFAULT" ]; then
  if grep -q 'resume=' "$GRUB_DEFAULT"; then
    echo "Kernel cmdline already contains resume=, leaving GRUB untouched."
  else
    line=$(grep -E '^GRUB_CMDLINE_LINUX_DEFAULT=' "$GRUB_DEFAULT" || true)
    if [ -z "$line" ]; then
      echo "GRUB_CMDLINE_LINUX_DEFAULT=\"resume=${SWAP_FILE}\"" >> "$GRUB_DEFAULT"
    else
      val=${line#*=}
      case "$val" in
        \"*\") inner=${val%\"}; inner=${inner#\"} ;;
        *) inner=$val ;;
      esac
      if [ -z "$inner" ]; then
        new="\"resume=${SWAP_FILE}\""
      else
        new="\"${inner} resume=${SWAP_FILE}\""
      fi
      tmp=$(mktemp)
      sed "s|^GRUB_CMDLINE_LINUX_DEFAULT=.*$|GRUB_CMDLINE_LINUX_DEFAULT=${new}|" "$GRUB_DEFAULT" > "$tmp"
      mv "$tmp" "$GRUB_DEFAULT"
    fi
    if command -v update-grub >/dev/null 2>&1; then
      update-grub
    else
      echo "WARNING: update-grub not found, run the distro grub update manually." >&2
    fi
  fi
else
  echo "WARNING: ${GRUB_DEFAULT} not found, skipping resume= setup." >&2
fi

echo "--- verification ---"
free -h | awk '$1 ~ /Swap/ {print "swap total:", $2}'
if [ -f /boot/grub/grub.cfg ]; then
  grep -m1 'resume=' /boot/grub/grub.cfg || echo "WARNING: resume= not found in /boot/grub/grub.cfg"
else
  echo "WARNING: /boot/grub/grub.cfg not found (UEFI path may differ)"
fi
if [ -e /proc/driver/nvidia/suspend ]; then
  state=$(cat /proc/driver/nvidia/suspend)
  echo "nvidia suspend state: ${state}"
  if [ "$state" = "suspend" ]; then
    echo "WARNING: NVIDIA driver is stuck suspended, run: echo resume > /proc/driver/nvidia/suspend" >&2
  fi
fi
echo "Done. Reboot the machine when convenient so hibernation uses ${SWAP_FILE} with resume= set."
