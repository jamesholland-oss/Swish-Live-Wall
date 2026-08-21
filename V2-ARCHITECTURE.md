# Swish Control V2 architecture

Swish Control is one product with three local roles and one central server.

## Roles

### Live Wall
- Electron UI only.
- Public livestream multiview.
- No authentication required.
- Receives only sanitized room health: `roomId`, `roomName`, `health`, `issue`, and `changedAt`.
- Never receives CPU, RAM, IP, incident history, credentials, or fleet-wide technical data.

### Control Center
- Same Electron app.
- Live Wall is available before login.
- Overview, Rooms, and Incidents require a server login.
- Authentication token is kept in renderer memory only and expires server-side.
- Detailed telemetry is returned only by authenticated API routes.

### Room Agent
- Same installed app, but no BrowserWindow is created.
- No Dock icon in normal agent operation on macOS.
- Starts at login when packaged.
- Sends one outbound heartbeat every 10 seconds.
- Agent credentials can submit telemetry but cannot read dashboard data.
- Remote commands are disabled for the pilot.

## Server

The control server owns:
- agent enrollment
- per-agent credentials
- current health state
- incident state transitions
- historical telemetry samples
- Control Center authentication
- Slack critical/offline alerts
- sanitized Live Wall health endpoint

For the Monday pilot, persistence is a JSON state file. On Railway, mount a persistent volume and set `DATA_DIR` to the volume path.

## Health rules

- Offline: no heartbeat within 30 seconds.
- Critical: OBS process is not running.
- Warning: OBS WebSocket unavailable/unauthenticated, RAM >= 90%, CPU >= 90%, or disk <= 10% free.
- Healthy: none of the above.

Streaming active/idle is displayed as telemetry but does not currently change health. This prevents false alarms when a room is intentionally not live.

## History

- Every agent enrollment creates an informational history event.
- Every health transition opens/resolves an incident.
- Telemetry is sampled every five minutes by default.
- Default sample retention is seven days (2,016 samples per agent).
- Incident history is retained in the server state file.

## Security boundaries

- Live Wall status endpoint exposes no private telemetry.
- Tech endpoints require a Control Center session token.
- Agent heartbeat endpoints require per-agent tokens.
- Enrollment uses a separate shared enrollment key.
- Agent tokens are stored hashed on the server.
- Remote arbitrary shell execution is not implemented.
- Remote recovery endpoint exists only as a disabled pilot placeholder.

## Next phase after pilot

1. Validate health thresholds with real office Macs.
2. Add expected-live schedules before alerting on stream inactivity.
3. Add signed/notarized packaging.
4. Add safe command queue with explicit allowlisted actions.
5. Add automatic updater.
6. Replace pilot persistence with Postgres when fleet scale justifies it.
