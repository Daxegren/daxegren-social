import { AdapterError, type FetchLike } from "./types.js";

export interface HttpResult<T> {
  body: T;
  headers: Headers;
  status: number;
}

/** JSON request that maps HTTP failures onto retryable / permanent AdapterErrors. */
export async function requestJson<T = unknown>(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<HttpResult<T>> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    throw new AdapterError(`network error: ${(err as Error).message}`, false);
  }

  const text = await res.text();
  if (!res.ok) {
    const transient = res.status === 429 || res.status >= 500;
    throw new AdapterError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 500)}`, !transient, res.status);
  }

  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { body: body as T, headers: res.headers, status: res.status };
}
