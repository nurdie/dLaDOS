#!/usr/bin/env bash
set -euo pipefail

detect_platform() {
  # Raspberry Pi: check device-tree model or cpuinfo
  if grep -qi "raspberry pi" /proc/device-tree/model 2>/dev/null || \
     grep -qi "raspberry pi" /proc/cpuinfo 2>/dev/null; then
    echo "rpi"
    return
  fi

  # AMD: ROCm exposes /dev/kfd
  if [ -e /dev/kfd ]; then
    echo "amd"
    return
  fi

  # NVIDIA: nvidia-smi is available and working
  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null 2>&1; then
    echo "nvidia"
    return
  fi

  echo "cpu"
}

PLATFORM=$(detect_platform)

case "$PLATFORM" in
  rpi)
    echo "[run.sh] Raspberry Pi detected — using ARM64/CPU config"
    exec docker compose -f docker-compose.yml -f docker-compose.rpi.yml "$@"
    ;;
  amd)
    echo "[run.sh] AMD GPU detected — using ROCm image"
    exec docker compose -f docker-compose.yml -f docker-compose.amd.yml "$@"
    ;;
  nvidia)
    echo "[run.sh] NVIDIA GPU detected — using CUDA image"
    exec docker compose -f docker-compose.yml -f docker-compose.nvidia.yml "$@"
    ;;
  *)
    echo "[run.sh] No GPU detected — using CPU (inference will be slow)"
    exec docker compose -f docker-compose.yml "$@"
    ;;
esac
