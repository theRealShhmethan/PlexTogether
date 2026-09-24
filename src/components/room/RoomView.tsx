"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/client/api";
import type { PublicParticipant, PublicRoom } from "@/lib/rooms/protocol";
import { driftLabel } from "@/lib/sync/drift";
import { PermissionsPanel } from "./PermissionsPanel";
import { forgetAutoload, RoomPlayer } from "./RoomPlayer";
import { useRoomSocket, type SocketStatus } from "./useRoomSocket";

const ENDED_TEXT: Record<string, string> = {
  "host-ended": "The host ended this watch party.",
  expired: "This watch party expired.",
  replaced: "The host started a new watch party.",
};

function StatusLine({ status, rttMs }: { status: SocketStatus; rttMs: number | null }) {
  if (status === "open") return <span className="muted small">● Connected{rttMs !== null ? ` · ${rttMs} ms` : ""}</span>;
  if (status === "connecting") return <span className="muted small">Connecting…</span>;
  if (status === "reconnecting") return <span className="error small">Connection lost — reconnecting…</span>;
  return null;
}

function SyncCell({ p, room }: { p: PublicParticipant; room: PublicRoom }) {
  if (!p.playerReady) return <span className="muted small">{p.connected ? "no video yet" : ""}</span>;
  if (p.buffering) return <span className="error small">buffering…</span>;
  if (room.playback.by === p.id && room.playback.status !== "idle") return <span className="muted small">setting the pace</span>;
  if (room.playback.status !== "playing") return <span className="muted small">video loaded</span>;
  return <span className={p.driftMs !== null && Math.abs(p.driftMs) < 250 ? "sync ok small" : "sync small"}>{driftLabel(p.driftMs)}</span>;
}

export function RoomView({
  initial,
  isHost,
  inviteUrl,
}: {
  initial: PublicRoom;
  isHost: boolean;
  inviteUrl: string;
}) {
  const router = useRouter();
  const { room, status, endedReason, rttMs, send, serverNow } = useRoomSocket(initial.id, initial);
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
    <>
      <section className="panel">
        <div className="page-header">
          <h2>Room {room.code}</h2>
          <StatusLine status={status} rttMs={rttMs} />
        </div>
        <p>
          <strong>{room.title}</strong>
        </p>

        {isHost && (
          <div className="invite">
            <label className="muted small" htmlFor="invite">
              Invite link — anyone with it can join until you end the room
            </label>
            <div className="row">
              <input id="invite" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
              <button className="button" onClick={() => void copyInvite()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <RoomPlayer
          roomId={room.id}
          me={room.you}
          isHost={isHost}
          permissions={me?.permissions ?? { playPause: false, seek: false }}
          playback={room.playback}
          durationMs={room.durationMs}
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
    </>
  );
}
