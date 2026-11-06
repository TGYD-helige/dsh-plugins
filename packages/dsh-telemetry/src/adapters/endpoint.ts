export function traceEndpoint(base: string, suffix: string) {
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid telemetry collector endpoint');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1/traces') ? path : `${path}${suffix}`;
  return url.toString();
}
