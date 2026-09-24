"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/client/api";
import type { PublicRoom } from "@/lib/rooms/protocol";
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
  const { room, status, endedReason, rttMs, send } = useRoomSocket(initial.id, initial);
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
          {isHost && (
            <button className="button" disabled title="Synchronised playback is the next phase">
              Start Together
            </button>
          )}
        </div>
        <p className="muted small">
          {room.participants.length < 2
            ? "Waiting for someone to join…"
            : everyoneReady
              ? "Everyone is ready."
              : `Waiting for ${waitingFor.join(", ")}…`}{" "}
          Synchronised playback (Start Together) comes in the next phase.
        </p>
        {!isHost && (
          <p className="muted small">Video for guests isn&apos;t set up yet — for now the room shows who&apos;s here and ready.</p>
        )}
      </section>

      <div className="row">
        <button className="button secondary" onClick={() => void endOrLeave()} disabled={busy}>
          {isHost ? "End watch party" : "Leave"}
        </button>
        <span className="muted small">Room expires {new Date(room.expiresAt).toLocaleTimeString()}</span>
      </div>
    </>
  );
}
