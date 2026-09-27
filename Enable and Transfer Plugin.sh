#!/bin/bash

echo "========================================="
echo "Choice Stream Backend Installer"
echo "========================================="
echo "This script will install the backend database router into SillyTavern."
echo "DANGER/WARNING: This will modify your config.yaml to set 'enableServerPlugins: true'."
echo "Allowing Server Plugins means any GitHub extension with a backend script can execute Node.js code on your machine."
echo "Ensure you only install extensions you trust."
echo "========================================="
echo ""

read -p "Do you wish to proceed? (Y/n): " choice
if [[ ! "$choice" =~ ^[Yy]$ ]]; then
    echo "Installation aborted."
    exit 0
fi

# Calculate paths
CURRENT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ST_ROOT="$(cd "$CURRENT_DIR/../../../../" && pwd)"

CONFIG_PATH="$ST_ROOT/config.yaml"
PLUGIN_DEST_DIR="$ST_ROOT/plugins/sillytavern_extension-choices"
PLUGIN_DEST_FILE="$PLUGIN_DEST_DIR/index.js"
PLUGIN_SRC_FILE="$CURRENT_DIR/_plugins/index.js"

if [ ! -f "$CONFIG_PATH" ]; then
    echo "[ERROR] Could not find config.yaml at $CONFIG_PATH. Are you running this in the right folder?"
    exit 1
fi

# Modify config.yaml using sed
sed -i -E 's/enableServerPlugins:[[:space:]]*false/enableServerPlugins: true/gI' "$CONFIG_PATH"
echo "[OK] config.yaml updated (enableServerPlugins: true)."

if [ ! -f "$PLUGIN_SRC_FILE" ]; then
    echo "[ERROR] Source backend file not found at $PLUGIN_SRC_FILE."
    exit 1
fi

mkdir -p "$PLUGIN_DEST_DIR"
cp "$PLUGIN_SRC_FILE" "$PLUGIN_DEST_FILE"

echo "[OK] Backend router installed to $PLUGIN_DEST_FILE"
echo ""
echo "SUCCESS! You must completely restart the SillyTavern command console (e.g. start.sh) for the backend to load."