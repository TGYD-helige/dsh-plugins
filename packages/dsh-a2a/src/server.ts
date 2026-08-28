/**
 * HTTP layer: the @a2a-js/sdk Express middlewares on a plain Express app.
 *
 * - `GET /.well-known/agent-card.json` (and the legacy `agent.json` alias) —
 *   agent card, via the SDK's `agentCardHandler`
 * - `POST <basePath>/` — JSON-RPC: A2A 1.0 methods (`SendMessage`,
 *   `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
 *   `SubscribeToTask`, ...) plus the v0.3 spellings (`message/send`, ...)
 *   through the SDK's opt-in legacyCompat layer
 *
 * The SSE framing and error envelopes are the SDK's; this layer only binds
 * the server and builds the card.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  type AgentCard,
  type AgentInterface,
} from '@a2a-js/sdk';
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3';
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

  const interfaces: AgentInterface[] = [
    {
      url: `${publicUrl}${base}/`,
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ];
  const card: AgentCard = {
    name: options.card.name,
    description: options.card.description,
    version: options.card.version,
    // The v0.3 mirror entries let pre-1.0 clients keep working through the
    // legacyCompat layer (they discover the card without an A2A-Version header).
    supportedInterfaces: duplicateInterfacesForLegacy(interfaces, ['JSONRPC']),
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
    signatures: [],
  };

  const requestHandler = new DefaultRequestHandler(card, options.taskStore, options.executor);

  const app = express();
  // The SDK's jsonRpcHandler parses bodies with express.json()'s 100kb default;
  // raise the ceiling here — body-parser skips re-parsing an already-read body.
  app.use(express.json({ limit: '16mb' }));
  const cardHandler = agentCardHandler({
    agentCardProvider: requestHandler,
    legacyCompat: { enabled: true },
  });
  app.use(`/${AGENT_CARD_PATH}`, cardHandler);
  // Pre-1.0 discovery path, kept as a convenience alias.
  app.use('/.well-known/agent.json', cardHandler);
  // dsh ships no authn/authz — the loopback default binding is the boundary.
  app.use(
    base,
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true },
    }),
  );

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
