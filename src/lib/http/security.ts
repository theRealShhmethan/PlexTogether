/**
 * CSRF defence for state-changing routes: browsers always send `Origin` on
 * cross-origin POSTs (and on same-origin fetch POSTs), so requiring it to
 * equal our own origin blocks other sites from triggering logins/logouts.
 */
export function isSameOrigin(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === appOrigin;
}

export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}
