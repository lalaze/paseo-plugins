import { useRef } from 'react';

export interface PendingOperation<T> {
  /**
   * Returns the stable operationId and the frozen request payload for this logical action. The key
   * identifies the *intent* (for example `taskId + body`), deliberately excluding the polling
   * revision: background refreshes must not change the id or the payload. The first call freezes the
   * payload (including the revision seen at that moment), and later calls with the same key return it
   * unchanged, so a retry after a lost response reuses the original request instead of creating a new
   * round or a second Git refresh.
   */
  begin(key: string, payload: T): { operationId: string; payload: T };
  /**
   * Clears the pending operation once its matching receipt has arrived, OR once the server made an
   * explicit decision (`isExplicitRejection`). Callers must NOT settle on an uncertain transport
   * failure: keeping the frozen request is what prevents a lost response from applying the action
   * twice. After settling, the next `begin` with the same key mints a fresh id and reads the latest
   * revision, so an explicit retry recovers from a conflict instead of failing forever.
   */
  settle(): void;
}

export function usePendingOperation<T>(): PendingOperation<T> {
  const ref = useRef<{ key: string; id: string; payload: T } | null>(null);
  return {
    begin(key, payload) {
      if (!ref.current || ref.current.key !== key) {
        ref.current = { key, id: crypto.randomUUID(), payload };
      }
      return { operationId: ref.current.id, payload: ref.current.payload };
    },
    settle() {
      ref.current = null;
    },
  };
}
