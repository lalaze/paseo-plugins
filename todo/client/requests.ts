/** Latest response wins, including errors; finishing an old request cannot unlock a newer one. */
export class LatestRequests {
  private readonly requests = new Map<string, { pending: boolean }>();

  begin(key: string, force = false) {
    if (!force && this.requests.get(key)?.pending) return null;
    const request = { pending: true };
    this.requests.set(key, request);
    return {
      current: () => this.requests.get(key) === request,
      finish: () => { request.pending = false; },
    };
  }

  clear(): void { this.requests.clear(); }
}
