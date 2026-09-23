import { AsyncLocalStorage } from 'node:async_hooks';

/** Request-scoped ownership; the SDK may mint contextId after HTTP parsing. */
export const requestIdentity = new AsyncLocalStorage<string | undefined>();
