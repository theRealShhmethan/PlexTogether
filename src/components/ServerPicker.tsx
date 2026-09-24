"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PublicConnection, PublicProbe, PublicSelection, PublicServer } from "@/lib/servers/service";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; servers: PublicServer[] };

const REASONS: Record<string, string> = {
  unreachable: "unreachable",
  timeout: "timed out",
  "wrong-server": "answered as a different server",
  unauthorized: "token rejected",
  "http-error": "HTTP error",
  "bad-response": "unexpected response",
};

function describeConnection(c: PublicConnection): string {
  return `${c.kind} ${c.protocol}${c.ipv6 ? " (IPv6)" : ""}`;
}

function ProbeList({ probes }: { probes: PublicProbe[] }) {
  return (
    <ul className="muted small">
      {probes.map((p, i) => (
        <li key={i}>
          {describeConnection(p)}: {p.ok ? `ok (${p.latencyMs} ms)` : REASONS[p.reason]}
        </li>
      ))}
    </ul>
  );
}

async function readError(res: Response): Promise<{ message: string; probes: PublicProbe[] }> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; probes?: PublicProbe[] };
  return { message: body.error ?? `Request failed (HTTP ${res.status})`, probes: body.probes ?? [] };
}

type LoadResult = { list: ListState; selected: PublicSelection | null };

async function fetchServerList(): Promise<LoadResult> {
  try {
    const res = await fetch("/api/plex/servers");
    if (!res.ok) return { list: { kind: "error", message: (await readError(res)).message }, selected: null };
    const body = (await res.json()) as { servers: PublicServer[]; selected: PublicSelection | null };
    return { list: { kind: "ready", servers: body.servers }, selected: body.selected };
  } catch {
    return { list: { kind: "error", message: "Network error while loading servers." }, selected: null };
  }
}

export function ServerPicker() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [selected, setSelected] = useState<PublicSelection | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<{ message: string; probes: PublicProbe[] } | null>(null);
  // Every connection's result from the last successful check (diagnostics).
  const [lastProbes, setLastProbes] = useState<PublicProbe[]>([]);

  const apply = useCallback((r: LoadResult) => {
    setList(r.list);
    setSelected(r.selected);
  }, []);

  const load = useCallback(() => {
    setList({ kind: "loading" });
    void fetchServerList().then(apply);
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    void fetchServerList().then((r) => {
      if (!cancelled) apply(r);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  async function select(serverId: string) {
    setBusyId(serverId);
    setSelectError(null);
    setLastProbes([]);
    try {
      const res = await fetch("/api/plex/servers/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      });
      if (!res.ok) {
        setSelectError(await readError(res));
        return;
      }
      const body = (await res.json()) as { selected: PublicSelection; probes: PublicProbe[] };
      setSelected(body.selected);
      setLastProbes(body.probes);
    } catch {
      setSelectError({ message: "Network error while checking the server.", probes: [] });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel">
      <h2>Plex Media Server</h2>

      {selected && (
        <div className="status ok">
          <strong>Connected to {selected.name}</strong>
          <span className="muted">
            {describeConnection(selected.connection)} · {selected.latencyMs} ms
            {selected.version ? ` · PMS ${selected.version}` : ""}
            {!selected.owned && selected.ownerName ? ` · shared by ${selected.ownerName}` : ""}
          </span>
          {lastProbes.length > 1 && <ProbeList probes={lastProbes} />}
          <Link href="/browse">Browse library →</Link>
        </div>
      )}

      {selectError && (
        <div className="status bad">
          <strong className="error">{selectError.message}</strong>
          {selectError.probes.length > 0 && <ProbeList probes={selectError.probes} />}
        </div>
      )}

      {list.kind === "loading" && <p className="muted">Loading servers from Plex…</p>}
      {list.kind === "error" && (
        <>
          <p className="error">{list.message}</p>
          <button className="button secondary" onClick={load}>
            Retry
          </button>
        </>
      )}
      {list.kind === "ready" && list.servers.length === 0 && (
        <p className="muted">No Plex Media Servers found on this account.</p>
      )}
      {list.kind === "ready" && list.servers.length > 0 && (
        <ul className="server-list">
          {list.servers.map((s) => (
            <li key={s.id} className="server">
              <div>
                <strong>{s.name}</strong>
                <div className="muted">
                  {s.owned ? "Owned by you" : `Shared by ${s.ownerName ?? "another account"}`}
                  {s.online === false ? " · offline" : ""}
                  {s.version ? ` · v${s.version}` : ""}
                  {s.platform ? ` · ${s.platform}` : ""}
                </div>
                <div className="muted small">
                  Connections: {s.connections.local} local, {s.connections.remote} remote, {s.connections.relay} relay
                </div>
              </div>
              <button
                className={selected?.serverId === s.id ? "button secondary" : "button"}
                onClick={() => void select(s.id)}
                disabled={busyId !== null || !s.hasAccess}
              >
                {busyId === s.id ? "Checking…" : selected?.serverId === s.id ? "Re-check" : "Select"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
