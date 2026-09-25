import type { Message } from '@a2a-js/sdk';

export class ApprovalReplyError extends Error {}

export interface A2aApproval {
  requestId: string;
  toolName: string;
  reason?: string;
  callId?: string;
}

export interface A2aApprovalReply {
  /** A legacy codec may correlate by a unique callId instead. */
  requestId?: string;
  callId?: string;
  outcome: 'allowed-once' | 'rejected';
}

/** A2A has no standard approval DataPart schema. Deployments may replace this codec. */
export interface A2aApprovalCodec {
  encode(request: A2aApproval): Record<string, unknown>;
  decode(message: Message): A2aApprovalReply | undefined;
}

export const defaultApprovalCodec: A2aApprovalCodec = {
  encode: ({ requestId, toolName, reason, callId }) => ({ requestId, toolName, reason, callId }),
  decode(message) {
    const data =
      message.parts.length === 1 && message.parts[0].content?.$case === 'data'
        ? message.parts[0].content.value
        : undefined;
    if (!data || !Object.hasOwn(data, 'requestId')) return;
    if (
      typeof data.requestId !== 'string' ||
      !data.requestId ||
      (data.outcome !== 'allowed-once' && data.outcome !== 'rejected') ||
      (data.callId !== undefined && typeof data.callId !== 'string')
    ) {
      throw new Error('Unsupported approval reply.');
    }
    return { requestId: data.requestId, outcome: data.outcome, callId: data.callId };
  },
};
