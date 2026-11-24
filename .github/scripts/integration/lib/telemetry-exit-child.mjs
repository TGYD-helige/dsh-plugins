import { setTimeout as delay } from 'node:timers/promises';
import { adapters } from '../../../../packages/dsh-telemetry/lib/adapters/index.js';
import { TelemetryReporter } from '../../../../packages/dsh-telemetry/lib/core/otel.js';

const reporter = new TelemetryReporter(
  { backend: 'phoenix', endpoint: process.argv[2], captureContent: false },
  adapters.phoenix,
);
await reporter.ready;
reporter.endSpan(reporter.openTrace({ name: 'expires first' }));
await delay(28_000);

// Headless DSH clears its five-second fallback once disposal completes and lets Node exit.
reporter.endSpan(reporter.openTrace({ name: 'still in budget' }));
const started = performance.now();
const fallback = setTimeout(() => process.exit(2), 5000);
await reporter.shutdown();
clearTimeout(fallback);
const disposedMs = performance.now() - started;
process.once('exit', () => {
  console.log(JSON.stringify({ disposedMs, exitMs: performance.now() - started }));
});
