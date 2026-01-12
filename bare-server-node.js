import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

function parseTargetFromHeaders(req) {
  const host = req.headers['x-bare-host'];
  if (!host) return null;
  const port = req.headers['x-bare-port'] || (req.headers['x-bare-protocol'] === 'https' ? '443' : '80');
  const protocol = req.headers['x-bare-protocol'] || 'http';
  const path = req.headers['x-bare-path'] || req.url || '/';
  let extraHeaders = {};
  if (req.headers['x-bare-headers']) {
    try {
      extraHeaders = JSON.parse(req.headers['x-bare-headers']);
    } catch (e) {
      extraHeaders = {};
    }
  }

  return {
    host,
    port: parseInt(port, 10),
    protocol,
    path,
    extraHeaders,
  };
}

function parseTargetFromUrl(req, basePath) {
  // Support URLs like /bare/https/example.com:443/some/path or /bare/example.com/some/path
  try {
    if (!req.url || !req.url.startsWith(basePath)) return null;
    const remainder = req.url.slice(basePath.length);
    if (!remainder) return null;

    // If remainder starts with a scheme, try to parse full URL
    if (remainder.startsWith('http://') || remainder.startsWith('https://')) {
      const url = new URL(remainder);
      return {
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
        protocol: url.protocol.replace(':', ''),
        path: url.pathname + url.search,
        extraHeaders: {},
      };
    }

    // Otherwise, treat first segment as host[:port]
    const parts = remainder.split('/');
    const hostPort = parts.shift();
    if (!hostPort) return null;
    const [host, port] = hostPort.split(':');
    const path = '/' + parts.join('/');
    return {
      host,
      port: port ? parseInt(port, 10) : 80,
      protocol: 'http',
      path,
      extraHeaders: {},
    };
  } catch (e) {
    return null;
  }
}

export function createBareServer(basePath = '/bare/') {
  const debug = Boolean(process.env.BARE_DEBUG || process.env.DEBUG_BARE);
  function tryParseHostPort(str) {
    if (!str) return null;
    if (str.startsWith('/')) str = str.slice(1);
    const [h, p] = str.split(':');
    if (!h) return null;
    return {
      host: h,
      port: p ? parseInt(p, 10) : 443,
      protocol: 'https',
      path: '/',
      extraHeaders: {},
    };
  }
  function shouldRoute(req) {
    return (
      (req.url && req.url.startsWith(basePath)) ||
      Boolean(req.headers['x-bare-host']) ||
      req.method === 'CONNECT'
    );
  }

  async function routeRequest(req, res) {
    // Handle HTTP CONNECT method (tunneling for HTTPS)
    if (req.method === 'CONNECT') {
      // In many setups the caller will use the `connect` event instead,
      // but support handling CONNECT here as a fallback where `res` is a socket-like stream.
      debug && console.log('[bare] routeRequest CONNECT entry', { url: req.url, host: req.headers && req.headers.host });
      let target = parseTargetFromHeaders(req) || parseTargetFromUrl(req, basePath);
      if (!target) {
        target = tryParseHostPort(req.url) || tryParseHostPort(req.headers && req.headers.host);
        if (!target && req.rawHeaders) {
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            if (req.rawHeaders[i].toLowerCase() === 'host') {
              target = tryParseHostPort(req.rawHeaders[i + 1]);
              break;
            }
          }
        }
      }
      if (!target) {
        debug && console.warn('[bare] CONNECT missing target information', req.url);
        try {
          res.writeHead && res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end && res.end('Missing target host information');
        } catch (e) {}
        return;
      }

      debug && console.log('[bare] CONNECT ->', target.host + ':' + target.port);
      const tunnel = net.connect({ host: target.host, port: target.port }, () => {
        try {
          // If `res` is actually a socket (from a `connect` event), write raw response
          if (res.write) {
            res.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          }
        } catch (e) {}
        tunnel.pipe(res);
        res.pipe(tunnel);
      });

      tunnel.on('error', (err) => {
        debug && console.warn('[bare] CONNECT tunnel error', String(err && err.message));
        try {
          res.end && res.end();
        } catch (e) {}
      });

      return;
    }
    const target = parseTargetFromHeaders(req) || parseTargetFromUrl(req, basePath);
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing target host information');
      return;
    }

    const isHttps = target.protocol === 'https' || target.port === 443;
    const client = isHttps ? https : http;

    const headers = { ...req.headers };
    // Remove internal x-bare-* headers
    Object.keys(headers).forEach((k) => {
      if (k.startsWith('x-bare-')) delete headers[k];
    });
    // Apply extra headers from x-bare-headers
    Object.assign(headers, target.extraHeaders || {});

    // Ensure Host header matches target
    headers.host = target.host + (target.port ? `:${target.port}` : '');

    const options = {
      hostname: target.host,
      port: target.port,
      method: req.method,
      path: target.path,
      headers,
    };

    const upstream = client.request(options, (upstreamRes) => {
      // Forward status and headers
      const forwardedHeaders = { ...upstreamRes.headers };
      // Remove hop-by-hop headers that shouldn't be forwarded in some cases
      res.writeHead(upstreamRes.statusCode || 502, forwardedHeaders);
      upstreamRes.pipe(res, { end: true });
    });

    upstream.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Upstream request failed: ' + String(err.message));
    });

    req.pipe(upstream, { end: true });
  }

  function routeUpgrade(req, socket, head) {
    debug && console.log('[bare] upgrade ->', req.url || req.headers.host);
    const target = parseTargetFromHeaders(req) || parseTargetFromUrl(req, basePath);
    if (!target) {
      socket.end();
      return;
    }

    const upstream = net.connect({ host: target.host, port: target.port }, () => {
      // Build raw request headers to send
      const rawHeaders = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const value = req.rawHeaders[i + 1];
        if (!name.toLowerCase().startsWith('x-bare-')) {
          rawHeaders.push(`${name}: ${value}`);
        }
      }
      // Ensure Host, Connection and Upgrade headers
      rawHeaders.unshift(`Host: ${target.host}${target.port ? `:${target.port}` : ''}`);
      rawHeaders.push('Connection: upgrade');

      const requestLine = `${req.method} ${target.path} HTTP/${req.httpVersion}\r\n` + rawHeaders.join('\r\n') + '\r\n\r\n';
      upstream.write(requestLine);
      if (head && head.length) upstream.write(head);

      // Pipe both ways
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on('error', () => {
      debug && console.warn('[bare] upgrade upstream error');
      try {
        socket.end();
      } catch (e) {}
    });
  }

  // Handler for `connect` events (HTTP CONNECT tunneling)
  function routeConnect(req, clientSocket, head) {
    debug && console.log('[bare] routeConnect entry', { url: req.url, host: req.headers && req.headers.host, rawHeadersLen: req.rawHeaders && req.rawHeaders.length });
    let target = parseTargetFromHeaders(req) || parseTargetFromUrl(req, basePath);
    // Fallback strategies for CONNECT: try req.url, req.headers.host, rawHeaders
    function tryParseHostPort(str) {
      if (!str) return null;
      if (str.startsWith('/')) str = str.slice(1);
      const [h, p] = str.split(':');
      if (!h) return null;
      return {
        host: h,
        port: p ? parseInt(p, 10) : 443,
        protocol: 'https',
        path: '/',
        extraHeaders: {},
      };
    }

    if (!target) {
      target = tryParseHostPort(req.url) || tryParseHostPort(req.headers && req.headers.host);
      if (!target && req.rawHeaders) {
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i].toLowerCase() === 'host') {
            target = tryParseHostPort(req.rawHeaders[i + 1]);
            break;
          }
        }
      }
    }
    if (!target) {
      debug && console.warn('[bare] CONNECT missing target for', req.url);
      try {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch (e) {}
      try { clientSocket.end(); } catch (e) {}
      return;
    }

    debug && console.log('[bare] connect ->', target.host + ':' + target.port);
    const upstream = net.connect({ host: target.host, port: target.port }, () => {
      try {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      } catch (e) {}
      // Pipe raw bytes both ways
      upstream.write(head || Buffer.alloc(0));
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', (err) => {
      debug && console.warn('[bare] connect upstream error', String(err && err.message));
      try { clientSocket.end(); } catch (e) {}
    });
  }

  return {
    shouldRoute,
    routeRequest,
    routeUpgrade,
    routeConnect,
  };
}
