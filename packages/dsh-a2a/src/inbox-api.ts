/** JSON-RPC method extension; standard task methods stay with the official SDK. */
import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  type AgentCard,
  Extensions,
  HTTP_EXTENSION_HEADER,
  Message,
} from '@a2a-js/sdk';
import {
  ExtensionSupportRequiredError,
  RequestMalformedError,
  toJsonRpcError,
} from '@a2a-js/sdk/errors';
import { validateVersion } from '@a2a-js/sdk/server';
import type { RequestHandler } from 'express';
import { INBOX_EXTENSION, type NativeInbox, validateInboxPage } from './inbox.js';

export function inboxRpcHandler(inbox: NativeInbox, card: AgentCard): RequestHandler {
  return async (req, res, next) => {
    const body = req.body;
    if (typeof body?.method !== 'string' || !body.method.startsWith('inbox/')) return next();
    try {
      if (body.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof body.id))
        throw new RequestMalformedError('A JSON-RPC 2.0 request id is required.');
      validateVersion(req.get(A2A_VERSION_HEADER) || A2A_PROTOCOL_VERSION, card, 'JSONRPC');
      if (
        !Extensions.parseServiceParameter(req.get(HTTP_EXTENSION_HEADER)).includes(INBOX_EXTENSION)
      )
        throw new ExtensionSupportRequiredError('Activate the native inbox extension.');
      res.setHeader(HTTP_EXTENSION_HEADER, INBOX_EXTENSION);
      const params = body.params;
      if (
        !params ||
        typeof params !== 'object' ||
        Array.isArray(params) ||
        typeof params.contextId !== 'string' ||
        !params.contextId.trim() ||
        (params.tenant !== undefined && params.tenant !== '')
      )
        throw new RequestMalformedError('A contextId and the default tenant are required.');
      const method = body.method.slice('inbox/'.length);
      const page = { pageSize: params.pageSize, pageToken: params.pageToken };
      validateInboxPage(page);
      if (method !== 'get' && page.pageToken)
        throw new RequestMalformedError('pageToken is only supported by inbox get.');
      if (
        ['update', 'move', 'remove', 'steer'].includes(method) &&
        (typeof params.id !== 'string' || !params.id)
      )
        throw new RequestMalformedError('A native inbox id is required.');
      let result: unknown;
      switch (method) {
        case 'get':
          result = await inbox.get(params.contextId, page);
          break;
        case 'update': {
          if (
            !params.message ||
            typeof params.message !== 'object' ||
            Array.isArray(params.message)
          )
            throw new RequestMalformedError('A user Message is required.');
          let message: Message;
          try {
            message = Message.fromJSON(params.message);
          } catch {
            throw new RequestMalformedError('Invalid A2A Message.');
          }
          result = await inbox.update(params.contextId, params.id, message, page);
          break;
        }
        case 'move':
          result = await inbox.move(params.contextId, params.id, params.index, page);
          break;
        case 'remove':
          result = await inbox.remove(params.contextId, params.id, page);
          break;
        case 'clear':
          result = await inbox.clearPending(params.contextId, page);
          break;
        case 'execute': {
          if (params.id !== undefined && (typeof params.id !== 'string' || !params.id))
            throw new RequestMalformedError('id must be a native inbox id.');
          result = await inbox.executePending(params.contextId, params.id, page);
          break;
        }
        case 'steer': {
          if (typeof params.taskId !== 'string' || !params.taskId)
            throw new RequestMalformedError('An active taskId is required.');
          await inbox.promote(params.contextId, params.id, params.taskId);
          result = await inbox.get(params.contextId, page);
          break;
        }
        case 'subscribe': {
          const agent = await inbox.resolve(params.contextId);
          if (res.destroyed) return;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          const dispose = inbox.changes.watch(
            agent.session,
            (change) => {
              if (res.destroyed || res.writableEnded) return;
              res.flushHeaders();
              if (
                !res.write(
                  `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: change })}\n\n`,
                )
              )
                res.destroy();
            },
            () => res.end(),
          );
          res.once('close', dispose);
          try {
            await inbox.changes.checkpoint(agent.session);
          } catch (error) {
            res.off('close', dispose);
            dispose();
            throw error;
          }
          return;
        }
        default:
          return next();
      }
      res.json({ jsonrpc: '2.0', id: body.id, result });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const response = { jsonrpc: '2.0', id: body?.id ?? null, error: toJsonRpcError(error) };
      if (res.headersSent) res.end(`data: ${JSON.stringify(response)}\n\n`);
      else {
        res.setHeader('Content-Type', 'application/json');
        res.json(response);
      }
    }
  };
}
