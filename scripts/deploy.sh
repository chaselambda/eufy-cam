#!/bin/bash
set -e

# Load env vars from .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

if [ -z "$DEPLOY_HOST" ]; then
  echo "Error: DEPLOY_HOST not set in .env"
  exit 1
fi

SERVER="root@$DEPLOY_HOST"
REMOTE_DIR="eufy-cam"

echo "Deploying to $SERVER..."
ssh -A "$SERVER" "source ~/.nvm/nvm.sh && cd $REMOTE_DIR && git pull && npm install && sudo systemctl restart eufy-mqtt eufy-capture"
echo "Deploy complete!"
