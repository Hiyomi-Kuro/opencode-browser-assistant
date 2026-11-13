import { normalizeBaseUrl } from './model-manager';

export interface HostPermissionApi {
  contains(details: { origins: string[] }): Promise<boolean>;
  request(details: { origins: string[] }): Promise<boolean>;
}

/** Call from the Side Panel click handler so optional host access stays user initiated. */
export async function ensureApiOriginPermission(permissions: HostPermissionApi, baseUrl: string): Promise<'granted' | 'denied'> {
  const origin = new URL(normalizeBaseUrl(baseUrl)).origin;
  const origins = [`${origin}/*`];
  if (await permissions.contains({ origins })) return 'granted';
  return (await permissions.request({ origins })) ? 'granted' : 'denied';
}
