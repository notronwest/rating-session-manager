#!/usr/bin/env bash
set -euo pipefail

# Setup script for macOS
# - Installs Homebrew (optional), ffmpeg, python
# - Creates .venv and installs Python deps

if ! command -v brew >/dev/null 2>&1; then
  echo "[INFO] Homebrew not found. Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

echo "[INFO] Installing ffmpeg and python via Homebrew..."
brew install ffmpeg python

echo "[INFO] Creating venv (.venv) and installing Python packages..."
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo "[OK] Setup complete. Activate with: source .venv/bin/activate"
