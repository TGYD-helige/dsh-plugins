// Loopback-only LLM gateway proxy for the DSH review job. The review model runs
// as `nobody` with a scrubbed environment, so it must not hold the gateway key:
// this proxy (started by the trusted workflow as the runner user) injects the
// Authorization header and forwards to the configured upstream only.
import http from 'node:http'
import https from 'node:https'

const upstream = new URL(process.env.DSH_INTEGRATION_BASE_URL || '')
const key = process.env.DSH_INTEGRATION_API_KEY || ''
if (!upstream.origin || upstream.origin === 'null' || !key) {
  console.error('review-gateway-proxy: DSH_INTEGRATION_BASE_URL / DSH_INTEGRATION_API_KEY required')
  process.exit(1)
}
const transport = upstream.protocol === 'https:' ? https : http

const server = http.createServer((req, res) => {
  // Strip the inbound hop-by-hop header; node's client sets its own.
  const headers = { ...req.headers, host: upstream.host, authorization: `Bearer ${key}` }
  delete headers.connection
  const proxyReq = transport.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      // Empty string falls back to the transport's default port (443/80).
      port: upstream.port,
      method: req.method,
      path: `${upstream.pathname.replace(/\/+$/, '')}${req.url}`,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', (error) => {
    res.writeHead(502)
    res.end(String(error))
  })
  req.pipe(proxyReq)
})
// LLM calls (SSE streams) can run for minutes; loopback-only, so no timeouts.
server.requestTimeout = 0
server.headersTimeout = 0

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`)
})
