#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo -e "${BLUE}=== Opencode CLI Setup for Raspberry Pi ===${NC}"

# 1. Install Opencode CLI
if ! command -v opencode &> /dev/null; then
    echo -e "${GREEN}[1/3] Installing @opencode-ai/cli globally...${NC}"
    npm install -g @opencode-ai/cli
else
    echo -e "${GREEN}[1/3] Opencode CLI already installed.${NC}"
fi

# 2. Configure Opencode
CONFIG_DIR="$HOME/.config/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"

mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${GREEN}[2/3] Creating opencode.json...${NC}"
    cat <<EOF > "$CONFIG_FILE"
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["@shaywong/opencode-antigravity-auth@latest"],
  "provider": {
    "google": {
      "models": {
        "antigravity-gemini-3-pro": {
          "name": "Gemini 3 Pro (Antigravity)",
          "limit": { "context": 1048576, "output": 65535 },
          "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
          "variants": {
            "low": { "thinkingLevel": "low" },
            "high": { "thinkingLevel": "high" }
          }
        }
      }
    }
  }
}
EOF
    echo "Configuration created at $CONFIG_FILE"
else
    echo -e "${YELLOW}[2/3] opencode.json already exists. Skipping overwrite.${NC}"
    echo "Make sure '@shaywong/opencode-antigravity-auth@latest' is in your 'plugin' list."
fi

# 3. Auth Instructions
echo -e "${BLUE}=== Authentication Required ===${NC}"
echo -e "${YELLOW}Since you are on a headless Pi, you need to use SSH port forwarding for the OAuth callback.${NC}"
echo ""
echo "1. On your LOCAL machine (laptop), run:"
echo "   ssh -L 51121:localhost:51121 pi@<YOUR_PI_IP>"
echo ""
echo "2. On the PI (this terminal), run:"
echo "   opencode auth login"
echo ""
echo "3. Open the URL in your local browser. The callback will be forwarded to the Pi."
