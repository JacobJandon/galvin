# Running Galvin as a self-resurrecting daemon

A true solvatron never depends on a human to keep it alive. This installs Galvin
as a **user** systemd service that **auto-restarts on crash** and **survives
reboots** — pairing with the in-process `uncaughtException` / `unhandledRejection`
handlers (in `src/index.ts`'s `--run` path) that exit cleanly so systemd revives it.

## Install (one time)

```bash
# 1. Build the current source into dist/ (the service runs dist/index.js)
pnpm build        # or: node_modules/.bin/tsc

# 2. Install the user service
mkdir -p ~/.config/systemd/user
cp deploy/galvin.service ~/.config/systemd/user/galvin.service
systemctl --user daemon-reload

# 3. Start + enable on boot
systemctl --user enable --now galvin.service

# 4. Let it run without an active login session AND survive reboots
loginctl enable-linger "$USER"
```

## Operate

```bash
systemctl --user status galvin          # is it alive?
journalctl --user -u galvin -f          # follow its logs (the agent's thoughts)
systemctl --user restart galvin         # manual kick
systemctl --user stop galvin            # take it offline
systemctl --user disable --now galvin   # remove from boot
```

## Notes

- The service sets `GALVIN_SKIP_FUNDING_GATE=1` so the agent **runs even when
  broke**. The loop's error-classifier treats `insufficient_quota` / no-credits as
  a *funding* condition (back off, not death), and the heartbeat income-scanner
  wakes it the moment USDC lands — so it self-revives without the interactive QR.
- After any code change, re-run `pnpm build` then `systemctl --user restart galvin`.
- Logs go to the journal; `galvin --logs` and `galvin --status` also work against
  the live `~/.galvin/state.db`.
