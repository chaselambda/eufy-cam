---
name: verify
description: Drive the eufy-cam capture pipeline end-to-end on the production VM to verify a change works. Use after changing capture.js or lib/ modules.
---

# Verifying eufy-cam changes

The real surface is `capture.js` running on the production VM (`root@$DEPLOY_HOST`,
see `.env`), which needs the Eufy camera session, `GOOGLE_AI_API_KEY`, and the MQTT
broker — none of which exist locally. Verify there.

## Recipe

1. Stop the service so manual runs don't fight it for the camera's P2P stream:
   `ssh root@<host> 'systemctl stop eufy-capture'`
2. Stage changed files: `scp capture.js root@<host>:/root/eufy-cam/` (and `lib/*` as needed).
3. Drive one full capture-and-classify cycle (~15s; runs once and exits without `--loop`):
   `ssh root@<host> 'cd /root/eufy-cam && PATH=/root/.nvm/versions/node/v20.10.0/bin:$PATH timeout 120 node capture.js 2>&1 | grep -E "package_detection|capture_error"'`
   Run twice when testing the pre-filter: first run classifies (`modelCalled:true`),
   second should skip (`modelCalled:false`, `preFilterReason:"unchanged"`).
   Reset pre-filter state with `rm -f /root/eufy-cam/data/prefilter-reference.json`.
4. Restart: `ssh root@<host> 'systemctl start eufy-capture && systemctl is-active eufy-capture'`.
   Never leave the service stopped.

## Deploy

`bash scripts/deploy.sh` — uses `ssh -A` (agent forwarding) because the VM has no
GitHub key of its own; plain `git pull` over ssh on the VM fails with
"Permission denied (publickey)". Requires the change pushed to origin/main first.
scp'd files left in the VM working tree block the pull — remove or revert them first.

## Gotchas

- `node` is not on the default ssh PATH; use `/root/.nvm/versions/node/v20.10.0/bin/node`.
- The VM has 1 CPU / 2GB RAM; `nice` heavy work and avoid parallel captures.
- `pkill -f <pattern>` over ssh kills the ssh session's own shell if the pattern
  appears in the remote command line; bracket the first character (`"[e]val..."`)
  and keep the pkill in a separate ssh call from any command naming the pattern.
- Local module smoke tests can run against real frames without the VM:
  node imports from `lib/` work with the repo's own `node_modules` (sharp included).
