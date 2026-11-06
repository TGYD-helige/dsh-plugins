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
  url.pathname = url.pathname.replace(/\/$/, '');
  if (!url.pathname.endsWith('/v1/traces')) url.pathname += suffix;
  return url.toString();
}
