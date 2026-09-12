import { useCallback } from 'react';
export function useWorkspace(_id: string, selector: (value: { directory: string }) => unknown) { return selector({ directory: '/preview/workspace' }); }
export function useRpc(contract: { name: string }) {
  return useCallback(async (input: unknown) => {
    const response = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-preview-token': document.querySelector<HTMLMetaElement>('meta[name="preview-token"]')!.content }, body: JSON.stringify({ method: contract.name, input }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }, [contract.name]);
}
