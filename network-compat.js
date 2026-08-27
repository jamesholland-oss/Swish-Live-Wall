// Route Swish Control API requests through Electron's main process.
// Do not replace window.fetch: provider/browser traffic must stay untouched.
// Instead, replace only the app's fetchJson helper used by health/login/rooms/incidents.

(() => {
  if (!window.swish?.controlFetch || typeof fetchJson !== 'function') return;

  fetchJson = async function fetchJsonThroughMain(path, options = {}, timeoutMs = 5000) {
    const serverUrl = normalizeServerUrl(appConfig.serverUrl);
    if (!serverUrl) throw new Error('Server URL is not configured.');

    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
    if (options.auth !== false && authToken) headers.authorization = `Bearer ${authToken}`;

    const method = String(options.method || 'GET').toUpperCase();
    const url = `${serverUrl}${path}`;

    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Control server request timed out.')), timeoutMs);
    });

    try {
      const result = await Promise.race([
        window.swish.controlFetch({
          url,
          method,
          headers,
          body: options.body == null ? undefined : String(options.body)
        }),
        timeoutPromise
      ]);

      let data = {};
      if (result?.body) {
        try { data = JSON.parse(result.body); }
        catch (_) { data = {}; }
      }

      if (!result?.ok) {
        const error = new Error(data.error || `Server returned ${result?.status || 0}`);
        error.status = Number(result?.status || 0);
        throw error;
      }

      return data;
    } catch (err) {
      if (err?.status) throw err;
      throw new Error(`Control connection failed: ${err?.message || 'unknown error'}`);
    } finally {
      clearTimeout(timeout);
    }
  };
})();
