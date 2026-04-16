# Install dependencies for Pickleball Auto-Cut

This project needs **two** external programs plus a small Python environment.

## Required programs

1) **FFmpeg** (and ffprobe)
- Used for lossless clip export.

2) **Python 3.10+**
- Used for motion-based segmentation and SRT generation.

## macOS (recommended)

### 1) Install Homebrew (if needed)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2) Install programs

```bash
brew install ffmpeg python
```

### 3) Create a virtual environment + install Python packages

From inside the project folder (the folder containing `detect_games.py`):

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### 4) Verify

```bash
ffmpeg -version
python -c "import cv2, numpy; print('ok', cv2.__version__)"
```

## Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-venv python3-pip

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Windows (PowerShell)

### 1) Install Chocolatey (if needed)

Follow Chocolatey install instructions (admin PowerShell).

### 2) Install programs

```powershell
choco install -y ffmpeg python
```

### 3) Create venv + install packages

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Notes

- If you see `externally-managed-environment` on macOS, you **must** use a virtual environment (`python -m venv`).
- If OpenCV install fails on macOS, ensure you are using Homebrew Python (`brew install python`) and try again inside the venv.
