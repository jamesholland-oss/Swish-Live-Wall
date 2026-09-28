const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

function constantTimeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a || '')).digest();
  const right = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function htmlPage(title, message) {
  const safe = (value) => String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  return `<!doctype html>
<meta charset="utf-8">
<title>${safe(title)}</title>
<body style="margin:0;background:#07090d;color:#fff;font-family:Inter,system-ui,sans-serif">
  <main style="max-width:640px;margin:80px auto;padding:28px">
    <div style="font-size:12px;letter-spacing:.18em;color:#8d98a8">SWISH CONTROL</div>
    <h1 style="font-size:26px;margin:12px 0">${safe(title)}</h1>
    <p style="color:#aeb7c4;line-height:1.6">${safe(message)}</p>
  </main>
</body>`;
}

function createGoogleWorkspaceAuth(options = {}) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '');
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '');
  const redirectUrl = String(process.env.GOOGLE_OAUTH_REDIRECT_URL || '');
  const workspaceDomain = String(process.env.GOOGLE_WORKSPACE_DOMAIN || '').trim().toLowerCase();

  const flows = new Map();
  const FLOW_TTL_MS = 10 * 60 * 1000;
  const COMPLETED_TTL_MS = 2 * 60 * 1000;

  const configured = () => Boolean(clientId && clientSecret && redirectUrl && workspaceDomain);

  const client = () => new OAuth2Client(clientId, clientSecret, redirectUrl);

  function cleanup() {
    const now = Date.now();
    for (const [id, flow] of flows) {
      if (!flow || flow.expiresAt <= now) flows.delete(id);
    }
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, OPTIONS'
    });
    res.end(body);
  }

  function sendHtml(res, status, body) {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store'
    });
    res.end(body);
  }

  async function start(_req, res) {
    if (!configured()) {
      return sendJson(res, 503, { error: 'Google Workspace sign-in is not configured.' });
    }

    cleanup();
    const flowId = crypto.randomBytes(24).toString('hex');
    const state = crypto.randomBytes(32).toString('hex');

    flows.set(flowId, {
      flowId,
      state,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + FLOW_TTL_MS
    });

    const authUrl = client().generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      hd: workspaceDomain,
      state: `${flowId}.${state}`
    });

    return sendJson(res, 200, {
      flowId,
      authUrl,
      expiresInSeconds: Math.floor(FLOW_TTL_MS / 1000)
    });
  }

  async function callback(_req, res, url) {
    if (!configured()) {
      return sendHtml(res, 503, htmlPage(
        'Google sign-in is not configured',
        'Return to Swish Control and use the existing sign-in method.'
      ));
    }

    cleanup();

    if (url.searchParams.get('error')) {
      return sendHtml(res, 400, htmlPage(
        'Google sign-in cancelled',
        'You can close this window and return to Swish Control.'
      ));
    }

    const code = String(url.searchParams.get('code') || '');
    const combinedState = String(url.searchParams.get('state') || '');
    const separator = combinedState.indexOf('.');
    const flowId = separator > 0 ? combinedState.slice(0, separator) : '';
    const returnedState = separator > 0 ? combinedState.slice(separator + 1) : '';
    const flow = flows.get(flowId);

    if (!code || !flow || !returnedState || !constantTimeEqual(flow.state, returnedState)) {
      return sendHtml(res, 400, htmlPage(
        'Invalid or expired sign-in',
        'Return to Swish Control and start Google sign-in again.'
      ));
    }

    try {
      const oauth = client();
      const { tokens } = await oauth.getToken(code);
      if (!tokens?.id_token) throw new Error('Google did not return an ID token.');

      const ticket = await oauth.verifyIdToken({
        idToken: tokens.id_token,
        audience: clientId
      });
      const payload = ticket.getPayload() || {};
      const email = String(payload.email || '').trim().toLowerCase();
      const hostedDomain = String(payload.hd || '').trim().toLowerCase();

      if (!payload.email_verified || !email) {
        throw new Error('Google email could not be verified.');
      }

      if (!hostedDomain || hostedDomain !== workspaceDomain) {
        throw new Error('Use your company Google Workspace account.');
      }

      const user = options.getUserByEmail?.(email, {
        name: String(payload.name || '').trim(),
        picture: String(payload.picture || '').trim(),
        hostedDomain
      }) || null;
      if (!user) {
        flow.status = 'denied';
        flow.error = 'Your account has not been assigned Swish Control access.';
        flow.expiresAt = Date.now() + COMPLETED_TTL_MS;
        return sendHtml(res, 403, htmlPage(
          'Swish Control access not assigned',
          'Your Google Workspace account is valid, but an administrator has not assigned it a Swish Control role yet.'
        ));
      }

      const token = options.createSession(user);
      flow.status = 'complete';
      flow.token = token;
      flow.user = options.publicUser(user);
      flow.expiresAt = Date.now() + COMPLETED_TTL_MS;

      return sendHtml(res, 200, htmlPage(
        'Signed in',
        'You can close this window and return to Swish Control.'
      ));
    } catch (err) {
      flow.status = 'error';
      flow.error = err?.message || 'Google sign-in failed.';
      flow.expiresAt = Date.now() + COMPLETED_TTL_MS;
      return sendHtml(res, 400, htmlPage(
        'Google sign-in failed',
        'Return to Swish Control and try again.'
      ));
    }
  }

  function status(_req, res, url) {
    cleanup();
    const flowId = String(url.searchParams.get('flowId') || '');
    const flow = flows.get(flowId);
    if (!flow) return sendJson(res, 404, { error: 'Google sign-in request expired.' });

    if (flow.status === 'complete') {
      return sendJson(res, 200, {
        status: 'complete',
        token: flow.token,
        user: flow.user
      });
    }

    if (flow.status === 'denied' || flow.status === 'error') {
      return sendJson(res, 200, {
        status: flow.status,
        error: flow.error || 'Google sign-in failed.'
      });
    }

    return sendJson(res, 200, { status: 'pending' });
  }

  return {
    configured,
    start,
    callback,
    status
  };
}

module.exports = { createGoogleWorkspaceAuth };
