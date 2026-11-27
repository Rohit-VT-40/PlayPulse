#!/bin/bash

# Move to the directory where Start-PlayPulse.command is located
cd "$(dirname "$0")" || exit 1

echo ""
echo "================================================="
echo "   PlayPulse Intelligence Launcher (macOS)"
echo "================================================="
echo ""

# Ensure common macOS Node paths (Homebrew Apple Silicon/Intel & NVM) are loaded
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi

# 1. Verify Node.js is installed
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed on this Mac."
  echo "Please install Node.js LTS from: https://nodejs.org"
  echo ""
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

# 2. Check if PlayPulse server is already running on port 3000
if lsof -iTCP:3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "PlayPulse server is already running on port 3000!"
  echo "Opening http://localhost:3000 in your browser..."
  open "http://localhost:3000"
  sleep 2
  exit 0
fi

# 3. First-time setup: auto-install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
  echo "First-time setup: Installing required packages..."
  npm install
  if [ $? -ne 0 ]; then
    echo ""
    echo "[ERROR] Package installation failed. Check your internet connection."
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
  fi
fi

echo "Keep this window open while using PlayPulse."
echo "Close this window (or press Ctrl+C) anytime to stop the server."
echo ""

# 4. Open default browser after 2 seconds
(sleep 2 && open "http://localhost:3000") &

# 5. Start the Node server
node server.mjs

echo ""
echo "Server stopped."
read -n 1 -s -r -p "Press any key to close..."
