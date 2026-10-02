const bearerToken = /^[A-Za-z0-9._~+/=-]{1,512}$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

/** Returns a SHA-256 client fingerprint only when the bearer token matches a configured key. */
export async function authenticatedClientFingerprint(request: Request, configuredKeys?: string): Promise<string | undefined> {
  const authorization = request.headers.get('authorization');
  const match = authorization && /^Bearer ([^\s,]+)$/i.exec(authorization);
  if (!match || !bearerToken.test(match[1]!)) return undefined;

  const keys = [...new Set((configuredKeys ?? '').split(',').map(key => key.trim()).filter(key => bearerToken.test(key)))];
  if (!keys.length) return undefined;

  const suppliedHash = await sha256(match[1]!);
  let matched = 0;
  for (const key of keys) matched |= Number(sameDigest(suppliedHash, await sha256(key)));
  return matched ? bytesToHex(suppliedHash) : undefined;
}
