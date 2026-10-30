import { Extensions } from '@a2a-js/sdk';
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server';
import {
  type A2ARequestHandler,
  defaultServerCallContextBuilder,
  validateVersion,
} from '@a2a-js/sdk/server';
import { UserBuilder } from '@a2a-js/sdk/server/express';
import type { RequestHandler } from 'express';

/** SDK 1.1.0 derives legacy final from task terminality, losing interaction endings. */
export function legacyStreamHandler(requestHandler: A2ARequestHandler): RequestHandler {
  const transport = new LegacyJsonRpcTransportHandler(requestHandler);
  return async (req, res, next) => {
    if (
      req.method !== 'POST' ||
      req.path !== '/' ||
      !req.is('application/json') ||
      !['message/stream', 'tasks/resubscribe'].includes(req.body?.method)
    ) {
      next();
      return;
    }
    const errorResponse = (error: unknown) => ({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: LegacyJsonRpcTransportHandler.mapToLegacyJSONRPCError(error),
    });
    try {
      const context = defaultServerCallContextBuilder({
        extensions: Extensions.parseServiceParameter(
          req.header('X-A2A-Extensions') ?? req.header('A2A-Extensions'),
        ),
        user: await UserBuilder.noAuthentication(),
        headers: req.headers,
        requestedVersion: req.header('A2A-Version'),
      });
      validateVersion(context.requestedVersion, await requestHandler.getAgentCard(), 'JSONRPC');
      const response = await transport.handle(req.body, context);
      if (!(Symbol.asyncIterator in response)) {
        res.json(response);
        return;
      }
      const stream = response;
      const resubscribing = req.body.method === 'tasks/resubscribe';
      let closed!: () => void;
      const close = new Promise<void>((resolve) => (closed = resolve));
      if (resubscribing) res.once('close', closed);
      try {
        const startStream = () => {
          if (context.activatedExtensions)
            res.setHeader('X-A2A-Extensions', Array.from(context.activatedExtensions));
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders();
        };
        // The SDK always streams resubscribe errors; sends validate before SSE headers.
        if (resubscribing) startStream();
        const next = () => (resubscribing ? Promise.race([stream.next(), close]) : stream.next());
        const first = await next();
        if (!first) return;
        if (!res.headersSent) startStream();
        let last: Exclude<typeof first.value, void> | undefined;
        const write = async (event: Exclude<typeof first.value, void>) => {
          last = event;
          const result = event.result as
            | { kind?: string; status?: { state?: string }; final?: boolean }
            | undefined;
          // INPUT_REQUIRED closes the SDK queue, including real approval waits.
          // A task snapshot on resubscribe does not close it and is left intact.
          if (result?.kind === 'status-update' && result.status?.state === 'input-required')
            result.final = true;
          if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) {
            await new Promise<void>((resolve) => {
              const ready = () => {
                res.off('drain', ready);
                res.off('close', ready);
                resolve();
              };
              res.once('drain', ready);
              res.once('close', ready);
            });
          }
          return result?.kind === 'status-update' && result.final;
        };
        if (!first.done && (await write(first.value))) return;
        while (true) {
          const nextEvent = await next();
          if (!nextEvent || nextEvent.done) break;
          if (res.destroyed && !resubscribing) continue; // Sends still drain for persistence.
          if (res.destroyed) break;
          if (await write(nextEvent.value)) return;
        }
        // A cold subscription has no live bus: the SDK ends after the snapshot.
        const snapshot = last?.result as
          | { kind?: string; id?: string; contextId?: string; status?: unknown; metadata?: unknown }
          | undefined;
        if (!res.destroyed && snapshot?.kind === 'task')
          await write({
            ...last!,
            result: {
              kind: 'status-update',
              taskId: snapshot.id,
              contextId: snapshot.contextId,
              status: snapshot.status,
              metadata: snapshot.metadata,
              final: true,
            },
          });
      } finally {
        if (resubscribing) res.off('close', closed);
        await stream.return(undefined);
      }
    } catch (error) {
      console.error('[dsh-a2a] legacy stream failed:', error);
      if (!res.headersSent) res.json(errorResponse(error));
      else if (!res.destroyed)
        res.write(`event: error\ndata: ${JSON.stringify(errorResponse(error))}\n\n`);
    } finally {
      if (!res.writableEnded) res.end();
    }
  };
}
