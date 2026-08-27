/**
 * HTTP layer: the @a2a-js/sdk Express middlewares on a plain Express app.
 *
 * - `GET /.well-known/agent-card.json` (and the legacy `agent.json` alias) —
 *   agent card, via the SDK's `agentCardHandler`
 * - `POST <basePath>/` — JSON-RPC, via the SDK's `jsonRpcHandler`
 *   (`message/send`, `message/stream` as SSE, `tasks/get`, `tasks/cancel`,
 *   `tasks/resubscribe`, and the push-notification methods)
 *
 * The SSE framing, heartbeat-free streaming, and error envelopes are the
 * SDK's; this layer only binds the server and builds the card.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk';
import { type AgentExecutor, DefaultRequestHandler, type TaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import express from 'express';

export interface A2aServerOptions {
  host: string;
  port: number;
  basePath: string;
  card: {
    name: string;
    description: string;
    version: string;
    /** Public base URL advertised in the card, e.g. https://agent.example.com */
    publicUrl?: string;
  };
  executor: AgentExecutor;
  taskStore: TaskStore;
}

export interface A2aServer {
  /** The bound port (differs from options.port when 0). */
  port: number;
  close(): Promise<void>;
}

export async function startA2aServer(options: A2aServerOptions): Promise<A2aServer> {
  const base = options.basePath.replace(/\/$/, '');
  const publicUrl = (options.card.publicUrl ?? `http://${options.host}:${options.port}`).replace(
    /\/$/,
    '',
  );

  const card: AgentCard = {
    name: options.card.name,
    description: options.card.description,
    version: options.card.version,
    protocolVersion: '0.3.0',
    url: `${publicUrl}${base}/`,
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  };

  const requestHandler = new DefaultRequestHandler(card, options.taskStore, options.executor);

  const app = express();
  // The SDK's jsonRpcHandler parses bodies with express.json()'s 100kb default;
  // raise the ceiling here — body-parser skips re-parsing an already-read body.
  app.use(express.json({ limit: '16mb' }));
  const cardHandler = agentCardHandler({ agentCardProvider: requestHandler });
  app.use(`/${AGENT_CARD_PATH}`, cardHandler);
  // Pre-0.3 discovery path, kept as a convenience alias.
  app.use('/.well-known/agent.json', cardHandler);
  // dsh ships no authn/authz — the loopback default binding is the boundary.
  app.use(base, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
