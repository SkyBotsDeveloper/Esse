export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}
export function invalid(message: string): never { throw new AppError(400, 'INVALID_REQUEST', message); }
export function malformed(provider: string): never {
  throw new AppError(502, 'INVALID_UPSTREAM_RESPONSE', `${provider} returned an invalid response.`);
}
