import type { PendingRequest } from './broker';
import { ProviderError } from './protocol';
export async function claimApproval(): Promise<string | null> {
  const response = await chrome.runtime.sendMessage({ type: 'nacre:claim-approval' });
  if (!response?.ok) throw new ProviderError(response?.error?.code ?? -32603, response?.error?.message ?? 'The toolbar request could not be opened.');
  return typeof response.value === 'string' ? response.value : null;
}
export async function approvalCall<T>(requestId: string, action: string, fields: Record<string, unknown> = {}): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type: 'nacre:approval', requestId, action, ...fields });
  if (!response?.ok) throw new ProviderError(response?.error?.code ?? -32603, response?.error?.message ?? 'The approval could not be completed.', response?.error?.data);
  return response.value as T;
}
export const readApproval = (id: string) => approvalCall<PendingRequest>(id, 'read');
