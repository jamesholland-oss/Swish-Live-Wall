# Google Workspace Sign-In — Swish Control

Swish Control can use company Google Workspace accounts for desktop sign-in while keeping the existing password flow as a fallback.

## Google Cloud setup

1. Open Google Cloud Console → Google Auth Platform.
2. Configure the app:
   - App name: `Swish Control`
   - Audience: `Internal` when the Google Cloud project belongs to the same Workspace organization.
   - Support/contact email: a company-controlled address.
3. Open Google Auth Platform → Clients → Create Client.
4. Application type: `Web application`.
5. Name: `Swish Control Production`.
6. Add this Authorized redirect URI exactly:
   ```
   https://swish-live-wall-production.up.railway.app/api/auth/google/callback
   ```
7. Create the client and copy the Client ID and Client Secret.

## Railway environment variables

Set these on the Swish Control Railway service:

```text
GOOGLE_CLIENT_ID=<Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<Google OAuth client secret>
GOOGLE_OAUTH_REDIRECT_URL=https://swish-live-wall-production.up.railway.app/api/auth/google/callback
GOOGLE_WORKSPACE_DOMAIN=<company Workspace domain>
```

Do not commit the client secret.

## Assign access

Google proves the employee's identity. Swish Control still decides what that employee can see.

Add allowed users to `CONTROL_USERS_JSON`. Password is optional for Google-only users.

Example:

```json
[
  {
    "email": "admin@company.com",
    "name": "Admin User",
    "role": "super_admin"
  },
  {
    "email": "content@company.com",
    "name": "Content User",
    "role": "content"
  },
  {
    "email": "ops@company.com",
    "name": "Broadcast Ops",
    "role": "ops"
  }
]
```

Supported roles:

- `super_admin` — all permissions
- `admin` — technical, clips, business, reports, settings
- `business` — rooms, clips, fiscal/business data and reports
- `content` — wall, rooms and clips only; no fiscal data or technical/admin access
- `ops` — wall, rooms, technical, incidents, diagnostics and clips; no fiscal data
- `viewer` — wall and rooms
- `wall_only` — wall only

Existing password users can keep a `password` property in the same object.

## Desktop flow

1. User clicks `Continue with Google Workspace` in Swish Control.
2. Swish Control opens the system browser to Google.
3. Google signs in the user and sends the result to the Railway callback.
4. Railway validates:
   - Google ID token
   - verified email
   - Workspace hosted-domain claim
   - email exists in `CONTROL_USERS_JSON`
5. The desktop app polls a short-lived login flow ID and receives its Swish Control session.
6. Role permissions are enforced by the backend as well as the UI.

The Google client secret remains only on Railway; it is never embedded in the desktop app.
