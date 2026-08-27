// Route Swish Control API requests through Electron's main process.
// This keeps control-server traffic separate from provider webviews and avoids
// renderer-origin networking/CORS quirks without changing Live Wall behavior.

(() => {
  if (!window.swish?.controlFetch) return;

  const nativeFetch = window.fetch.bind(window);

  function headersObject(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    return { ...headers };
  }

  function responseFrom(result, url) {
    const body = String(result?.body ?? '');
    return {
      ok: Boolean(result?.ok),
      status: Number(result?.status || 0),
      statusText: String(result?.statusText || ''),
      headers: new Headers(result?.headers || {}),
      url,
      redirected: false,
      type: 'basic',
      text: async () => body,
      json: async () => JSON.parse(body),
      clone: () => responseFrom(result, url)
    };
  }

  window.fetch = async function swishControlFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL
      ? String(input)
      : String(input?.url || '');

    if (!/^https?:\/\//i.test(url)) return nativeFetch(input, init);

    const method = String(init.method || input?.method || 'GET').toUpperCase();
    const headers = headersObject(init.headers || input?.headers);
    const body = init.body == null ? undefined : String(init.body);

    try {
      const result = await window.swish.controlFetch({ url, method, headers, body });
      return responseFrom(result, url);
    } catch (err) {
      throw new TypeError(err?.message || 'Failed to fetch');
    }
  };
})();
