"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/client/api";
import type { PublicParticipant, PublicRoom } from "@/lib/rooms/protocol";
import { driftLabel } from "@/lib/sync/drift";
import { ChatPanel } from "./ChatPanel";
import { PermissionsPanel } from "./PermissionsPanel";
import { forgetAutoload, RoomPlayer } from "./RoomPlayer";
import { useRoomSocket, type SocketStatus } from "./useRoomSocket";

const ENDED_TEXT: Record<string, string> = {
  "host-ended": "The host ended this watch party.",
  expired: "This watch party expired.",
  replaced: "The host started a new watch party.",
};

function StatusLine({ status, rttMs }: { status: SocketStatus; rttMs: number | null }) {
  if (status === "open")
    return <span className="muted small">● Connected{rttMs !== null ? ` · ${rttMs} ms` : ""}</span>;
  if (status === "connecting") return <span className="muted small">Connecting…</span>;
  if (status === "reconnecting") return <span className="error small">Connection lost — reconnecting…</span>;
  return null;
}

function SyncCell({ p, room }: { p: PublicParticipant; room: PublicRoom }) {
  if (!p.playerReady) return <span className="muted small">{p.connected ? "no video yet" : ""}</span>;
  if (p.buffering) return <span className="error small">buffering…</span>;
  if (room.playback.by === p.id && room.playback.status !== "idle")
    return <span className="muted small">setting the pace</span>;
  if (room.playback.status !== "playing") return <span className="muted small">video loaded</span>;
  return (
    <span className={p.driftMs !== null && Math.abs(p.driftMs) < 250 ? "sync ok small" : "sync small"}>
      {driftLabel(p.driftMs)}
    </span>
  );
}

export function RoomView({ initial, isHost, inviteUrl }: { initial: PublicRoom; isHost: boolean; inviteUrl: string }) {
  const router = useRouter();
  const { room, status, endedReason, rttMs, send, serverNow, chat, reactions, notice } = useRoomSocket(
    initial.id,
    initial,
  );
  const [changeError, setChangeError] = useState<string | null>(null);

  async function nextEpisode() {
    setChangeError(null);
    const r = await postJson(`/api/rooms/${room.id}/item`, { next: true });
    if (!r.ok) setChangeError(r.error);
  }
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  if (status === "ended") {
    return (
      <section className="panel">
        <h2>Watch party over</h2>
        <p>{ENDED_TEXT[endedReason ?? ""] ?? "This watch party has ended."}</p>
        <Link href="/">Back to PlexTogether</Link>
      </section>
    );
  }
  if (status === "not-participant") {
    return (
      <section className="panel">
        <p>You&apos;re no longer in this watch party.</p>
        <button className="button" onClick={() => router.refresh()}>
          Rejoin
        </button>
      </section>
    );
  }

  const me = room.participants.find((p) => p.id === room.you);
  const everyoneReady = room.participants.length > 1 && room.participants.every((p) => p.ready);
  const waitingFor = room.participants.filter((p) => !p.ready).map((p) => p.name);
  const startHint =
    room.participants.length < 2
      ? "Waiting for someone to join…"
      : everyoneReady
        ? "Everyone is ready."
        : `Waiting for ${waitingFor.join(", ")}…`;

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Clipboard blocked: the field is selectable. */
    }
  }

  async function endOrLeave() {
    if (isHost && !window.confirm("End the watch party for everyone?")) return;
    setBusy(true);
    forgetAutoload(room.id);
    await postJson(`/api/rooms/${room.id}/${isHost ? "end" : "leave"}`, {});
    setBusy(false);
    router.push(isHost ? "/browse" : "/");
  }

  return (
    <div className="room-layout">
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
      <div className="room-main">
        <section className="panel">
          <RoomPlayer
            key={room.itemKey}
            autoStart={room.autoStart}
            allLoaded={room.participants.filter((p) => p.connected).every((p) => p.playerReady)}
            next={room.next}
            onNextEpisode={nextEpisode}
            reactions={reactions}
            roomId={room.id}
            me={room.you}
            isHost={isHost}
            permissions={me?.permissions ?? { playPause: false, seek: false }}
            playback={room.playback}
            durationMs={room.durationMs}
            resumeMs={room.resumeMs}
            waitingFor={room.waitingFor}
            nameOf={(id) => room.participants.find((p) => p.id === id)?.name ?? null}
            serverNow={serverNow}
            rttMs={rttMs}
            send={send}
            connected={status === "open"}
            canStart={everyoneReady}
            startHint={startHint}
          />
        </section>
      </div>

      <aside className="room-side">
        <section className="panel">
          <div className="page-header">
            <div className="room-title">
              <strong>{room.title}</strong>
              <span className="room-code">ROOM {room.code}</span>
            </div>
            <StatusLine status={status} rttMs={rttMs} />
          </div>

          {isHost && (
            <div className="invite">
              <label className="muted small" htmlFor="invite">
                Invite link — send it to your guest. Anyone with it can join until you end the room.
              </label>
              <div className="row">
                <input id="invite" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
                <button className="button" onClick={() => void copyInvite()}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          {isHost && (
            <div className="row">
              <Link className="button secondary small-button" href="/browse">
                Change title
              </Link>
              {room.next && (
                <button className="button secondary small-button" onClick={() => void nextEpisode()} title={room.next.title}>
                  Next episode ▶
                </button>
              )}
            </div>
          )}
          {changeError && <p className="error small">{changeError}</p>}
        </section>

        <ChatPanel messages={chat} me={room.you} send={send} disabled={status !== "open"} />

        <section className="panel">
          <h2>Who&apos;s here</h2>
          <ul className="participants">
            {room.participants.map((p) => (
              <li key={p.id}>
                <span className={p.connected ? "dot on" : "dot"} title={p.connected ? "Connected" : "Not connected"} />
                <span className="name">
                  {p.name}
                  {p.id === room.you && <span className="muted"> (you)</span>}
                  {p.role === "host" && <span className="badge">host</span>}
                </span>
                <SyncCell p={p} room={room} />
                <span className={p.ready ? "ready yes" : "ready"}>{p.ready ? "Ready" : "Not ready"}</span>
              </li>
            ))}
          </ul>

          <div className="row">
            <button
              className={me?.ready ? "button secondary" : "button"}
              onClick={() => send({ type: "ready", ready: !me?.ready })}
              disabled={status !== "open"}
            >
              {me?.ready ? "I'm not ready" : "I'm ready"}
            </button>
          </div>
          <p className="muted small">{startHint} Loading the video marks you ready.</p>
        </section>

        {isHost && <PermissionsPanel room={room} send={send} disabled={status !== "open"} />}

        <div className="row">
          <button className="button secondary" onClick={() => void endOrLeave()} disabled={busy}>
            {isHost ? "End watch party" : "Leave"}
          </button>
          <span className="muted small">Room expires {new Date(room.expiresAt).toLocaleTimeString()}</span>
        </div>
      </aside>
    </div>
  );
}
