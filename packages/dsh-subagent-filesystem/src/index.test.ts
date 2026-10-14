import { Context } from '@deepseek-ai/cordis';
import type Agents from '@deepseek-ai/dsh-agent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type FileSystem from '@deepseek-ai/dsh-fs';
import { type FsTarget, FsTargetKey } from '@deepseek-ai/dsh-fs';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import type SessionQuery from '@deepseek-ai/dsh-session-query';
import type Subagents from '@deepseek-ai/dsh-subagent';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { afterEach, expect, it, vi } from 'vitest';
import { apply, inject } from './index.js';

const role = `---\nname: inventory-analyst\ndescription: Investigate stock discrepancies\n---\nCompare movements. Keep {{literal}} unchanged.`;
const contexts: Context[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()));
});

async function setup(
  files = new Map([['/remote/a/agents/inventory.md', role]]),
  config = { enabled: true, root: 'agents' },
) {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Application rules' });
  await ctx.plugin(Tools);
  ctx.systemPrompt.section({ name: 'core', order: 0, text: 'Core instructions' });
  const target = (path: string): FsTarget => ({
    targetKey: FsTargetKey(`remote:${path}`),
    displayPath: path,
  });
  const fs = {
    resolve: vi.fn(async (path, options) =>
      target(path.startsWith('/') ? path : `${options.cwd}/${path}`),
    ),
    stat: vi.fn(async (t) =>
      [...files.keys()].some((f) => f.startsWith(`${t.displayPath}/`))
        ? { type: 'directory' }
        : undefined,
    ),
    listDir: vi.fn(async (t) =>
      [...files.keys()]
        .filter(
          (f) =>
            f.startsWith(`${t.displayPath}/`) && !f.slice(t.displayPath.length + 1).includes('/'),
        )
        .map((f) => ({ name: f.split('/').at(-1), type: 'file', target: target(f) })),
    ),
    readBytes: vi.fn(async (t) => new TextEncoder().encode(files.get(t.displayPath))),
  };
  ctx.provide('fs', fs as unknown as FileSystem);
  const agents: Agent[] = [];
  ctx.provide('agents', {
    get: (id: string) => agents.find((agent) => agent.id === id),
  } as unknown as Agents);
  const records = new Map<string, { type: string; data: unknown }[]>();
  function agent(id: string, cwd: string, parent?: Agent) {
    const events: { type: string; data: unknown }[] = [];
    records.set(id, events);
    const a = {
      id: SessionId(id),
      session: {
        header: { id: SessionId(id), cwd, parentSession: parent?.id },
        append: vi.fn((type, data) => events.push({ type, data })),
      },
    } as unknown as Agent;
    Object.assign(a, { ctx: createScope(ctx, a).ctx });
    agents.push(a);
    return a;
  }
  ctx.provide('sessionQuery', {
    readSession: vi.fn(async (id) => ({ events: records.get(id), inheritedEventCount: 0 })),
  } as unknown as SessionQuery);
  const dispose = vi.fn(async () => {});
  const start = vi.fn(async (_provider, request) => {
    const child = agent(
      `child-${agents.length}`,
      request.parent.session.header.cwd,
      request.parent,
    );
    await ctx.serial('agent/created', { agent: child, source: 'startup' });
    return {
      id: child.id,
      result: Promise.resolve({
        stopReason: 'completed',
        output: [{ type: 'text', text: 'role worked' }],
      }),
      dispose,
    };
  });
  ctx.provide('subagents', {
    getProvider: vi.fn(() => ({
      name: 'spawn',
      inheritsParentContext: false,
      prepareContinuable() {},
    })),
    resolveMaxDepth: vi.fn(() => 2),
    start,
    startContinuable: vi.fn(async (spec) => ({
      childId: (await start(spec.provider, spec.request)).id,
    })),
    drainContinuableChildren: vi.fn(async () => {}),
  } as unknown as Subagents);
  const plugin = ctx.plugin({ apply, inject }, config);
  await plugin;
  const parent = agent('parent', '/remote/a');
  await ctx.serial('agent/created', { agent: parent, source: 'startup' });
  const delegate = (
    a = parent,
    args: unknown = { description: 'Check stock', prompt: 'Explain discrepancy' },
  ) =>
    ctx.tools.execute({
      name: 'subagent_inventory_analyst',
      callId: 'call-1' as never,
      arguments: args,
      signal: new AbortController().signal,
      agent: a,
    });
  return { ctx, fs, files, agents, records, parent, agent, delegate, start, dispose, plugin };
}

it('discovers remote Markdown roles and adds literal child system instructions without changing the user task', async () => {
  const h = await setup();
  expect(h.ctx.tools.get('subagent_inventory_analyst', h.parent)?.description).toContain(
    'Investigate stock discrepancies',
  );
  const result = await h.delegate();
  expect(result.isError).toBe(false);
  expect(h.start.mock.calls[0][1].prompt).toEqual([{ type: 'text', text: 'Explain discrepancy' }]);
  const child = h.agents[1];
  const prompt = await h.ctx.systemPrompt.assemble({ scope: child, agent: child });
  expect(prompt.sections.map((s) => s.text).join('\n')).toContain('Application rules');
  expect(prompt.sections).toContainEqual(
    expect.objectContaining({
      text: expect.stringContaining('Compare movements. Keep {{literal}} unchanged.'),
      interpolate: false,
    }),
  );
  expect(prompt.sections.map((s) => s.text).join('\n')).toContain('/remote/a/agents');
  expect(h.dispose).toHaveBeenCalledOnce();
});

it.each([
  'No frontmatter',
  '---\nname: [broken\n---\nBody',
  '---\nname: inventory-analyst\ndescription: Stock\n---\n ',
  '---\nname: inventory-analyst\n---\nBody',
  '---\nname: Invalid_name\ndescription: Stock\n---\nBody',
  '---\nname: inventory-analyst\ndescription: Stock\nmodel: ignored\n---\nBody',
  '---\nname: inventory-analyst\nname: other\ndescription: Stock\n---\nBody',
])('contains invalid role definitions without publishing a partial catalog: %s', async (text) => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const h = await setup(
    new Map([
      ['/remote/a/agents/valid.md', role],
      ['/remote/a/agents/invalid.md', text],
    ]),
  );
  expect(h.ctx.tools.get('subagent_inventory_analyst', h.parent)).toBeUndefined();
  expect(errors).toHaveBeenCalledWith(
    '[dsh-subagent-filesystem] Role discovery failed',
    expect.any(String),
  );
});

it('treats a missing root as an empty catalog, and stays idle when disabled', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const missing = await setup(new Map());
  expect(missing.ctx.tools.get('subagent_inventory_analyst', missing.parent)).toBeUndefined();
  expect(errors).not.toHaveBeenCalled();
  const disabled = await setup(undefined, { enabled: false, root: 'agents' });
  expect(disabled.fs.resolve).not.toHaveBeenCalled();
});

it('rejects duplicate names and existing tool collisions', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const h = await setup(
    new Map([
      ['/remote/a/agents/one.md', role],
      ['/remote/a/agents/two.md', role],
    ]),
  );
  expect(h.ctx.tools.get('subagent_inventory_analyst', h.parent)).toBeUndefined();
  h.files.delete('/remote/a/agents/two.md');
  await h.ctx.serial('agent/created', { agent: h.parent, source: 'startup' });
  const previous = h.ctx.tools.get('subagent_inventory_analyst', h.parent)!;
  await h.ctx.serial('agent/created', { agent: h.parent, source: 'startup' });
  expect(h.ctx.tools.get('subagent_inventory_analyst', h.parent)).toBeUndefined();
  expect(previous).toBeDefined();
});

it('isolates simultaneous delegations with the same name across remote workspaces', async () => {
  const h = await setup(
    new Map([
      ['/remote/a/agents/a.md', role],
      ['/remote/b/agents/b.md', role.replace('Compare movements.', 'Audit purchases.')],
    ]),
  );
  const other = h.agent('other-parent', '/remote/b');
  await h.ctx.serial('agent/created', { agent: other, source: 'startup' });
  expect(h.ctx.tools.get('subagent_inventory_analyst')).toBeUndefined();
  await Promise.all([h.delegate(), h.delegate(other)]);
  const children = h.agents.filter((a) => a.session.header.parentSession);
  const texts = await Promise.all(
    children.map(async (a) =>
      (await h.ctx.systemPrompt.assemble({ scope: a, agent: a })).sections
        .map((s) => s.text)
        .join('\n'),
    ),
  );
  expect(texts[0]).toContain('Compare movements.');
  expect(texts[0]).not.toContain('Audit purchases.');
  expect(texts[1]).toContain('Audit purchases.');
  expect(texts[1]).not.toContain('Compare movements.');
});

it('restores a background role snapshot and releases only owned children on unload', async () => {
  const h = await setup();
  const result = await h.delegate(h.parent, {
    description: 'Stock check',
    prompt: 'Inspect stock',
    run_in_background: true,
  });
  expect(result.isError).toBe(false);
  const child = h.agents[1];
  const saved = h.records.get(child.id)!;
  const restored = h.agent('restored', '/remote/a', h.parent);
  h.records.set(restored.id, saved);
  h.files.clear();
  await h.ctx.serial('agent/created', { agent: restored, source: 'resume' });
  expect(
    (await h.ctx.systemPrompt.assemble({ scope: restored })).sections.map((s) => s.text).join('\n'),
  ).toContain('Compare movements.');
  await h.plugin.dispose();
  expect(h.ctx.subagents.drainContinuableChildren).toHaveBeenCalledWith(h.parent, [
    child.id,
    restored.id,
  ]);
  expect(h.ctx.tools.get('subagent_inventory_analyst', h.parent)).toBeUndefined();
  expect(
    (await h.ctx.systemPrompt.assemble({ scope: child })).sections.some(
      (s) => s.name === 'subagent-filesystem:role',
    ),
  ).toBe(false);
});

it.each(['compact', 'clear'] as const)(
  'reinstalls a persisted specialist on %s reconstruction',
  async (source) => {
    const h = await setup();
    await h.delegate();
    const original = h.agents[1];
    const saved = h.records.get(original.id)!;
    const rebuilt = h.agent(`rebuilt-${source}`, '/remote/a', h.parent);
    h.records.set(rebuilt.id, saved);
    await h.ctx.serial('agent/created', { agent: rebuilt, source });
    expect(
      (await h.ctx.systemPrompt.assemble({ scope: rebuilt })).sections
        .map((s) => s.text)
        .join('\n'),
    ).toContain('Compare movements.');
  },
);

it('rejects malformed restored snapshots instead of starting a roleless child', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const h = await setup();
  const restored = h.agent('corrupt-child', '/remote/a', h.parent);
  h.records.set(restored.id, [{ type: 'subagent-filesystem/role', data: { version: 2 } }]);
  await expect(
    h.ctx.serial('agent/created', { agent: restored, source: 'resume' }),
  ).rejects.toThrow('Unsupported role snapshot version');
  expect(errors).toHaveBeenCalledWith('[dsh-subagent-filesystem] Child role initialization failed');
});

it('cancels and drains an active foreground delegation when the plugin unloads', async () => {
  const h = await setup();
  h.start.mockImplementationOnce(async (_provider, request) => ({
    id: SessionId('active-child'),
    result: new Promise((resolve) =>
      request.signal.addEventListener(
        'abort',
        () => resolve({ stopReason: 'aborted', output: [] }),
        { once: true },
      ),
    ),
    dispose: h.dispose,
  }));
  const call = h.delegate();
  await vi.waitFor(() => expect(h.start).toHaveBeenCalledOnce());
  await h.plugin.dispose();
  expect((await call).isError).toBe(true);
  expect(h.dispose).toHaveBeenCalledOnce();
});

it('honors the tool policy gate and passes the native depth limit and cancellation signal', async () => {
  const h = await setup();
  const off = h.ctx.on('tools/pre-execute', async () => ({
    kind: 'deny',
    reason: 'Stock role denied',
  }));
  expect((await h.delegate()).isError).toBe(true);
  expect(h.start).not.toHaveBeenCalled();
  off();
  await h.delegate();
  expect(h.start.mock.calls[0][1].maxDepth).toBe(2);
  const abort = new AbortController();
  abort.abort();
  expect(
    (
      await h.ctx.tools.execute({
        name: 'subagent_inventory_analyst',
        callId: 'canceled' as never,
        arguments: { description: 'Stock', prompt: 'Check' },
        agent: h.parent,
        signal: abort.signal,
      })
    ).isError,
  ).toBe(true);
  expect(h.start).toHaveBeenCalledOnce();
});

it('contains provider and result failures and always disposes an accepted foreground run', async () => {
  const h = await setup();
  h.start.mockImplementationOnce(async () => ({
    id: SessionId('failed'),
    result: Promise.reject(new Error('model failed')),
    dispose: h.dispose,
  }));
  expect((await h.delegate()).isError).toBe(true);
  expect(h.dispose).toHaveBeenCalledOnce();
  vi.mocked(h.ctx.subagents.getProvider).mockReturnValueOnce(undefined);
  expect((await h.delegate()).isError).toBe(true);
  expect(h.start).toHaveBeenCalledOnce();
});
