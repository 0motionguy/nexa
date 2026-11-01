export class ProviderRateLimitError extends Error {
  readonly vendor: string;
  readonly retryAfter: string | null;

  constructor(vendor: string, retryAfter: string | null = null) {
    super(`${vendor}_rate_limited`);
    this.name = 'ProviderRateLimitError';
    this.vendor = vendor;
    this.retryAfter = retryAfter;
  }
}

export function throwIfProviderRateLimited(res: Response, vendor: string): void {
  if (res.status === 429) {
    throw new ProviderRateLimitError(vendor, res.headers.get('Retry-After'));
  }
}
