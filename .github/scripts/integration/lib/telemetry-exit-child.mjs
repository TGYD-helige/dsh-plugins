import { get } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { adapters } from '../../../../packages/dsh-telemetry/lib/adapters/index.js';
import { TelemetryReporter } from '../../../../packages/dsh-telemetry/lib/core/otel.js';

const endpoint = process.argv[2];
const scenario = endpoint.split('/').at(-1);
let logStatus;
if (scenario === 'held') {
  const require = createRequire(
    new URL('../../../../packages/dsh-telemetry/package.json', import.meta.url),
  );
  const { diag, DiagLogLevel } = require('@opentelemetry/api');
  let sent = false;
  const noop = () => {};
  diag.setLogger(
    {
      error: noop,
      warn: noop,
      info: noop,
      verbose: noop,
      debug(...args) {
        if (
          sent ||
          !args.some((arg) => typeof arg === 'string' && arg.includes('items to be sent'))
        )
          return;
        sent = true;
        get(new URL('/host-log', endpoint), (res) => {
          logStatus = res.statusCode;
          res.resume();
        }).on('error', () => {
          logStatus = 'cancelled';
        });
      },
    },
    DiagLogLevel.DEBUG,
  );
}
const reporter = new TelemetryReporter(
  { backend: 'phoenix', endpoint, captureContent: false },
  adapters.phoenix,
);
await reporter.ready;
reporter.endSpan(reporter.openTrace({ name: 'expires first' }));
if (scenario === 'split') reporter.endSpan(reporter.openTrace({ name: 'split sibling' }));
await delay(28_000);

// Headless DSH clears its five-second fallback once disposal completes and lets Node exit.
reporter.endSpan(reporter.openTrace({ name: 'still in budget' }));
const started = performance.now();
const fallback = setTimeout(() => process.exit(2), 5000);
await reporter.shutdown();
clearTimeout(fallback);
const disposedMs = performance.now() - started;
process.once('exit', () => {
  console.log(JSON.stringify({ disposedMs, logStatus, exitMs: performance.now() - started }));
});
