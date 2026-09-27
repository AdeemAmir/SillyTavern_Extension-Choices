#!/usr/bin/env bash

echo "========================================="
echo "Choice Stream Backend Installer"
echo "========================================="
echo "This script will install the backend database router into SillyTavern."
echo "DANGER/WARNING: This will modify your config.yaml to set"
echo "'enableServerPlugins: true'."
echo
echo "Allowing Server Plugins means any GitHub extension with a backend"
echo "script can execute Node.js code on your machine."
echo "Ensure you only install extensions you trust."
echo "========================================="
echo

read -r -p "Do you wish to proceed? (Y/n): " CHOICE

if [[ "$CHOICE" != "y" && "$CHOICE" != "Y" ]]; then
    echo "Installation aborted."
    exit 0
fi

# -------------------------------------------------
# Calculate paths
#
# Script location:
# public/default-user/extensions/SillyTavern_Extension-Choices/
#
# ST root is 4 directories above this script
# -------------------------------------------------

CURRENT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ST_ROOT="$(cd -- "$CURRENT_DIR/../../../.." && pwd)"

CONFIG_PATH="$ST_ROOT/config.yaml"
PLUGIN_DEST_DIR="$ST_ROOT/plugins/SillyTavern_Extension-Choices"
PLUGIN_DEST_FILE="$PLUGIN_DEST_DIR/index.js"
PLUGIN_SRC_FILE="$CURRENT_DIR/_plugins/index.js"

# -------------------------------------------------
# 1. Modify config.yaml
# -------------------------------------------------

if [[ ! -f "$CONFIG_PATH" ]]; then
    echo "[ERROR] Could not find config.yaml at:"
    echo "$CONFIG_PATH"
    echo "Are you running this in the right folder?"
    exit 1
fi

python3 - "$CONFIG_PATH" <<'PY'
import sys
import re

path = sys.argv[1]

with open(path, "r", encoding="utf-8") as f:
    data = f.read()

data = re.sub(
    r'enableServerPlugins:\s*false',
    'enableServerPlugins: true',
    data,
    flags=re.IGNORECASE
)

with open(path, "w", encoding="utf-8") as f:
    f.write(data)
PY

if [[ $? -ne 0 ]]; then
    echo "[ERROR] Failed to modify config.yaml."
    exit 1
fi

echo "[OK] config.yaml updated (enableServerPlugins: true)."

# -------------------------------------------------
# 2. Copy Plugin Backend
# -------------------------------------------------

if [[ ! -f "$PLUGIN_SRC_FILE" ]]; then
    echo "[ERROR] Source backend file not found at:"
    echo "$PLUGIN_SRC_FILE"
    echo "Create the _plugins/index.js file first."
    exit 1
fi

mkdir -p "$PLUGIN_DEST_DIR"

if ! cp -f "$PLUGIN_SRC_FILE" "$PLUGIN_DEST_FILE"; then
    echo "[ERROR] Failed to copy backend router."
    exit 1
fi

echo "[OK] Backend router installed to:"
echo "$PLUGIN_DEST_FILE"

echo
echo "SUCCESS!"
echo "You must completely restart the SillyTavern command console/Start.sh"
echo "for the backend to load."
echo