# Swish Control V2

V2 evolves Swish Live Wall into a distributed broadcast operations system.

## Components

### Swish Control desktop app
The existing Electron app becomes the operator interface. Planned views:
- Overview
- Live Wall
- Rooms
- Incidents
- Automations

### Room Agent
`agent/agent.js` runs on each production computer and reports machine health to the control server every five seconds.

Initial telemetry:
- CPU utilization
- memory utilization
- machine uptime
- hostname/platform
- whether OBS is running

Later telemetry:
- OBS WebSocket connection
- stream/output status
- FPS / dropped frames / bitrate
- camera/source state
- audio state
- network quality

### Control Server
`control-server/server.js` receives agent heartbeats and maintains the current room state.

Initial endpoints:
- `GET /health`
- `GET /api/rooms`
- `GET /api/events` (Server-Sent Events)
- `POST /api/heartbeat`

Current health rules:
- healthy: agent responding and basic checks good
- warning: CPU or memory >= 90%
- critical: OBS is not running
- offline: no heartbeat for > 15 seconds

## Important safety model

V2 starts read-only. Monitoring must be reliable before remote commands or automatic recovery are enabled.

Future automation should follow:

Detect -> Diagnose -> Approved recovery action -> Verify -> Log -> Escalate if unresolved

Remote actions must be authenticated, allow-listed, auditable, and scoped to specific managed machines. Do not implement a generic remote shell.

## Development phases

1. Local machine telemetry
2. Room health inside Live Wall
3. OBS WebSocket telemetry
4. Persistent server/database and authentication
5. Incident history and operator alerts
6. Explicit manual recovery actions
7. Safe self-healing rules
8. Signed installers, auto-start agent, auto-update
9. Fleet management for large deployments
