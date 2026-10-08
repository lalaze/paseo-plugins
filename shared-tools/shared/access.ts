import type { ProviderAccess } from './rpc';

/** Missing rules retain the original behavior; an empty allowlist means nobody. */
export function allowsProvider(access: { providers?: string[] | null; excludedProviders?: string[] }, provider: string): boolean {
  return (access.providers == null || access.providers.includes(provider)) && !access.excludedProviders?.includes(provider);
}

export type AccessMode = 'all' | 'allow' | 'deny';

export function accessMode(access: ProviderAccess): AccessMode {
  return access.providers !== null ? 'allow' : access.excludedProviders?.length ? 'deny' : 'all';
}
