# Swish Control Server

The pilot server is dependency-free and requires Node.js 22+.

## Required environment variables

### `AGENT_ENROLLMENT_KEY`
A strong secret used only when a new room agent registers.

### `CONTROL_USERS_JSON`
JSON array of approved Control Center accounts.

Example shape:

```json
[
  {"email":"operator@example.com","password":"use-a-long-unique-password","name":"Operator"}
]
```

Do not commit real credentials to GitHub. Configure them as Railway variables.

## Optional environment variables

### `SLACK_WEBHOOK_URL`
Slack Incoming Webhook URL for critical/offline and recovery alerts.

### `DATA_DIR`
Persistent data directory. On Railway this should point at the mounted volume.

### `CONTROL_SESSION_HOURS`
Defaults to 12.

### `OFFLINE_AFTER_MS`
Defaults to 30000.

### `SAMPLE_INTERVAL_MS`
Defaults to 300000 (5 minutes).

### `MAX_SAMPLES_PER_AGENT`
Defaults to 2016 (7 days at 5-minute sampling).

## Local test

From the repository root:

```bash
AGENT_ENROLLMENT_KEY="dev-enrollment-key" \
CONTROL_USERS_JSON='[{"email":"admin@example.com","password":"change-me","name":"Admin"}]' \
npm run start:server
```

Health endpoint: `http://127.0.0.1:8787/health`

## Railway pilot

Use the `control-server` directory as the Railway service root and start with `npm start`.
Mount a persistent volume and set `DATA_DIR` to its mount path.
Configure credentials with Railway Variables, never source control.

## Pilot security note

The simple login stores approved account passwords in the server environment because this is a limited internal pilot. The next authentication step should move to password hashing or company SSO before broad deployment.
