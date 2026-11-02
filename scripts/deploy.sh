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
echo "Copying .env..."
scp .env "$SERVER:~/$REMOTE_DIR/.env"

# Reinstall the unit files on every deploy. They live in the repo but systemd
# reads them from /etc/systemd/system, so a unit edited here used to sit unused
# until someone remembered to copy it by hand - which is how the capture loop
# kept running at --loop 60s long after the repo said 180s.
ssh -A "$SERVER" "source ~/.nvm/nvm.sh && cd $REMOTE_DIR && git pull && npm install \
  && cp webserver/eufy-mqtt.service webserver/eufy-capture.service /etc/systemd/system/ \
  && systemctl daemon-reload \
  && systemctl restart eufy-mqtt eufy-capture"

echo "Verifying installed units match the repo..."
ssh -A "$SERVER" "cd $REMOTE_DIR && diff webserver/eufy-mqtt.service /etc/systemd/system/eufy-mqtt.service \
  && diff webserver/eufy-capture.service /etc/systemd/system/eufy-capture.service"

echo "Deploy complete!"
