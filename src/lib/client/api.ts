/** Browser-side JSON helpers for our own API routes. */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function parse<T>(res: Response): Promise<ApiResult<T>> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) return { ok: false, error: body?.error ?? `Request failed (HTTP ${res.status})` };
  if (body === null) return { ok: false, error: "Unexpected response" };
  return { ok: true, data: body };
}

export async function getJson<T>(url: string): Promise<ApiResult<T>> {
  try {
    return await parse<T>(await fetch(url));
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export async function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    return await parse<T>(
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    );
  } catch {
    return { ok: false, error: "Network error" };
  }
}
