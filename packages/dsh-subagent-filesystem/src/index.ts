import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-fs';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-query';
import { settleRun } from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { parseDocument } from 'yaml';

export const name = 'dsh-subagent-filesystem';
export const inject = ['fs', 'tools', 'subagents', 'systemPrompt', 'sessionQuery'];
export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(false),
  root: Schema.string().default('agents'),
  agentOptions: Schema.union([
    Schema.const(undefined),
    Schema.object({
      provider: Schema.string(),
      model: Schema.string(),
      reasoningEffort: Schema.transform(Schema.string().min(1), ReasoningEffortId),
      maxTokens: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
    }),
  ]).default(undefined),
  toolFilter: Schema.union([
    Schema.const(undefined),
    Schema.object({
      allow: Schema.union([Schema.const(undefined), Schema.array(Schema.string())]).default(
        undefined,
      ),
      deny: Schema.union([Schema.const(undefined), Schema.array(Schema.string())]).default(
        undefined,
      ),
    }),
  ]).default(undefined),
});
export interface Config {
  enabled: boolean;
  root?: string;
  agentOptions?: AgentOptions;
  toolFilter?: { allow?: string[]; deny?: string[] };
}

interface Role {
  version: 1;
  name: string;
  description: string;
  body: string;
  path: string;
}

class DefinitionError extends Error {}

function assertRole(value: unknown): asserts value is Role {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DefinitionError('Invalid role snapshot');
  }
  const { version, name, description, body, path } = value as Record<string, unknown>;
  if (version !== 1) throw new DefinitionError('Unsupported role snapshot version');
  if (
    typeof name !== 'string' ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) ||
    name.length > 55
  ) {
    throw new DefinitionError('Expected a kebab-case name of at most 55 characters');
  }
  if (
    typeof description !== 'string' ||
    !description.trim() ||
    typeof body !== 'string' ||
    !body.trim() ||
    typeof path !== 'string' ||
    !path
  ) {
    throw new DefinitionError('Expected a nonempty description, role body and definition path');
  }
  if (Buffer.byteLength(body) + Buffer.byteLength(description) > 1024 * 1024) {
    throw new DefinitionError('Role definition exceeds 1 MiB');
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'subagent-filesystem/role': Role;
  }
}

function parseRole(text: string, path: string): Role {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new DefinitionError('Expected YAML frontmatter');
  const doc = parseDocument(match[1]);
  if (doc.errors.length) throw new DefinitionError('Invalid YAML frontmatter');
  const metadata = doc.toJS({ maxAliasCount: 0 });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new DefinitionError('Expected name and description');
  }
  if (Object.keys(metadata).some((key) => key !== 'name' && key !== 'description')) {
    throw new DefinitionError('Only name and description are supported');
  }
  const { name, description } = metadata;
  const body = text.slice(match[0].length).trim();
  const role = { version: 1, name, description, body, path };
  assertRole(role);
  return { ...role, description: role.description.trim() };
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return;
  if (!(config.root ?? 'agents').trim()) throw new Error('root must not be empty');
  const lifecycle = new AbortController();
  const delegation = new AsyncLocalStorage<{ parent: Agent; role: Role }>();
  const registrations = new Map<Agent, (() => void)[]>();
  const children = new Map<Agent, SessionId[]>();
  const pending = new Set<Promise<unknown>>();
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  }

  const own = (agent: Agent, dispose: () => void) => {
    const rows = registrations.get(agent) ?? [];
    rows.push(dispose);
    registrations.set(agent, rows);
  };
  const remove = (agent: Agent) => {
    for (const dispose of registrations.get(agent) ?? []) dispose();
    registrations.delete(agent);
    children.delete(agent);
  };

  // Verified against dsh-agent@0.2.0-rc.1: this serial event precedes the first prompt.
  ctx.on('agent/created', ({ agent, source, signal }) => {
    return track(initialize(agent, source, signal)).then(
      () => undefined,
      (error) => {
        console.error('[dsh-subagent-filesystem] Child role initialization failed');
        throw error;
      },
    );
  });
  ctx.on('agent/disposed', ({ agent }) => remove(agent));
  ctx.effect(() => async () => {
    lifecycle.abort();
    await Promise.allSettled([...pending]);
    const released = await Promise.allSettled(
      [...children].map(([parent, ids]) => ctx.subagents.drainContinuableChildren(parent, ids)),
    );
    for (const result of released) {
      if (result.status === 'rejected')
        console.error('[dsh-subagent-filesystem] Child cleanup failed');
    }
    for (const agent of registrations.keys()) remove(agent);
  });

  async function initialize(
    agent: Agent,
    source: string,
    requestedSignal?: AbortSignal,
  ): Promise<void> {
    const signal = AbortSignal.any([
      lifecycle.signal,
      ...(requestedSignal ? [requestedSignal] : []),
    ]);
    const inherited = delegation.getStore();
    if (agent.session.header.parentSession) {
      let role: Role | undefined;
      if (inherited?.parent.id === agent.session.header.parentSession) {
        role = inherited.role;
        agent.session.append('subagent-filesystem/role', role);
      } else if (source !== 'startup') {
        const log = await agent.ctx.get('sessionQuery')!.readSession(agent.id);
        for (const event of log.events.slice(log.inheritedEventCount)) {
          if (event.type === 'subagent-filesystem/role') {
            assertRole(event.data);
            role = event.data;
          }
        }
        const parent = ctx.get('agents')?.get(agent.session.header.parentSession);
        if (role && parent) {
          const ids = children.get(parent) ?? [];
          if (!ids.includes(agent.id)) ids.push(agent.id);
          children.set(parent, ids);
        }
      }
      if (role) {
        signal.throwIfAborted();
        own(
          agent,
          agent.ctx.get('systemPrompt')!.section({
            name: 'subagent-filesystem:role',
            order: agent.ctx.get('systemPrompt')!.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
            interpolate: false,
            text: `${role.body}\n\nRole definition: ${JSON.stringify(role.path)}. Resolve supporting references and scripts relative to ${JSON.stringify(dirname(role.path))} in your filesystem.`,
          }),
        );
      }
      return;
    }
    try {
      const cwd = agent.session.header.cwd;
      if (!cwd) throw new Error('The agent needs a workspace directory');
      const fs = agent.ctx.get('fs')!;
      const root = await fs.resolve(config.root ?? 'agents', { cwd, signal });
      const info = await fs.stat(root, signal);
      if (!info) return;
      if (info.type !== 'directory') throw new DefinitionError('root must be a directory');
      const roles: Role[] = [];
      const names = new Set<string>();
      for (const entry of await fs.listDir(root, signal)) {
        if (entry.type !== 'file' || !entry.name.endsWith('.md')) continue;
        if ((entry.size ?? 0) > 1024 * 1024) throw new DefinitionError('Role file exceeds 1 MiB');
        const bytes = await fs.readBytes(entry.target, signal, 1024 * 1024);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const role = parseRole(text, entry.target.displayPath);
        const toolName = `subagent_${role.name.replaceAll('-', '_')}`;
        if (names.has(toolName) || agent.ctx.get('tools')!.get(toolName, agent))
          throw new DefinitionError('Duplicate role or tool name');
        names.add(toolName);
        roles.push(role);
      }
      signal.throwIfAborted();
      for (const role of roles) {
        own(
          agent,
          agent.ctx.get('tools')!.register(
            defineTool({
              name: `subagent_${role.name.replaceAll('-', '_')}`,
              description: `${role.description} Delegate a self-contained task to this specialist. Foreground calls return its report; background calls return a continuable child id.`,
              parameters: {
                prompt: {
                  type: 'string',
                  required: true,
                  description: 'The complete delegated task.',
                },
                description: { type: 'string', required: true, description: 'Short task label.' },
                run_in_background: {
                  type: 'boolean',
                  description:
                    'Return a child id instead of waiting. Defaults to false; use send_message for follow-up.',
                },
              },
              output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
              },
              isConcurrencySafe: () => true,
              async execute(args, exec) {
                if (exec.agent !== agent) throw new Error('Role belongs to a different agent');
                const provider = agent.ctx.get('subagents')!.getProvider('spawn');
                if (!provider?.prepareContinuable || provider.inheritsParentContext)
                  throw new Error('Roles require the native in-process spawn provider');
                const signal = AbortSignal.any([exec.signal, lifecycle.signal]);
                signal.throwIfAborted();
                return track(
                  delegation.run({ parent: agent, role }, async () => {
                    const request = {
                      parent: agent,
                      prompt: [{ type: 'text' as const, text: args.prompt }],
                      maxDepth: agent.ctx.get('subagents')!.resolveMaxDepth(),
                      ...(config.agentOptions ? { agentOptions: config.agentOptions } : {}),
                      ...(config.toolFilter ? { toolFilter: config.toolFilter } : {}),
                    };
                    if (args.run_in_background) {
                      const child = await agent.ctx.get('subagents')!.startContinuable({
                        provider: 'spawn',
                        label: args.description,
                        request,
                        signal,
                      });
                      const ids = children.get(agent) ?? [];
                      ids.push(child.childId);
                      children.set(agent, ids);
                      return `started subagent ${child.childId}; use send_message to continue it`;
                    }
                    const outcome = await settleRun(
                      await agent.ctx
                        .get('subagents')!
                        .start('spawn', { ...request, label: args.description, signal }),
                    );
                    if (outcome.status !== 'completed')
                      throw new Error(outcome.detail ?? `Subagent ${outcome.status}`);
                    return outcome.result ?? '';
                  }),
                );
              },
            }),
          ),
        );
      }
    } catch (error) {
      remove(agent);
      if (!signal.aborted)
        console.error(
          '[dsh-subagent-filesystem] Role discovery failed',
          error instanceof DefinitionError
            ? error.message
            : error instanceof Error
              ? error.name
              : 'Error',
        );
    }
  }
}
