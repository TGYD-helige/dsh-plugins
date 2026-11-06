import { langfuse } from './langfuse/index.js';
import { phoenix } from './phoenix/index.js';
import type { Backend, ConnectionConfig, ObservationData } from './types.js';

export type { Attributes, Backend, ConnectionConfig, ObservationData } from './types.js';
export const adapters = { phoenix, langfuse };
export const resolveConnection = (config: ConnectionConfig, env: NodeJS.ProcessEnv = process.env) =>
  adapters[config.backend].resolve(config, env);
export const adapt = (backend: Backend, data: ObservationData) =>
  adapters[backend].attributes(data);
