export class ApiError extends Error {
  constructor(
    message: string,
    readonly providerCode?: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gather-Request': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(data.error ?? 'Something went wrong. Please try again.', data.provider?.code);
  return data as T;
}
