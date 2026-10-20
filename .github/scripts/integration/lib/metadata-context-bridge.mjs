/** E2E-only host: attach request metadata before a new root session starts. */
export const name = 'metadata-context-e2e';
export const inject = ['sessions'];

export function apply(ctx) {
  ctx.on('session/created', (session) => {
    if (session.header.parentSession) return;
    const metadata = {
      projectId: 'metadata-project',
      workspaceId: 'metadata-workspace',
      requestId: `metadata-request:${session.id}`,
      routing: { region: 'original-region', credential: 'sk-lf-metadata-private' },
      labels: ['original-label'],
      optional: null,
      empty: '',
      numericString: '123',
      attempt: 2,
      interactive: true,
      turn: -999,
      callId: 'caller-shadow',
      toolName: 'caller-shadow',
      provider: 'caller-shadow',
    };
    ctx.emit('langfuse/context', session.id, { metadata });
    // The plugin must own the request snapshot, including nested values.
    metadata.routing.region = 'mutated-after-emission';
    metadata.labels.push('mutated-after-emission');
    metadata.projectId = 'mutated-after-emission';
  });
}
