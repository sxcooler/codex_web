import type { McpServerElicitationRequestResponse } from '../.local/protocol/v2/McpServerElicitationRequestResponse.ts';

export function hasUserMarker(history: { turns: any[] }, marker: string): boolean {
  return marker.length > 0 && history.turns.some(turn => turn.items.some((item: any) =>
    item.type === 'userMessage' && item.content.some((part: any) =>
      part.type === 'text' && part.text.includes(marker))));
}

export function rejectionFor(method: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': return { decision: 'decline' };
    case 'item/permissions/requestApproval': return { permissions: {}, scope: 'turn' };
    case 'mcpServer/elicitation/request': return { action: 'decline', content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
    default: return undefined;
  }
}
