"use client";

import type { ClientMessage, Permissions, PublicRoom } from "@/lib/rooms/protocol";

/**
 * Host-only panel: what each guest may do. Changes are sent to the server,
 * which enforces them — hiding a guest's buttons alone wouldn't be enough.
 */
export function PermissionsPanel({
  room,
  send,
  disabled,
}: {
  room: PublicRoom;
  send: (msg: ClientMessage) => void;
  disabled: boolean;
}) {
  const guests = room.participants.filter((p) => p.role === "guest");
  const set = (participantId: string, permissions: Permissions) =>
    send({ type: "permissions", participantId, ...permissions });

  return (
    <section className="panel">
      <div className="page-header">
        <h2>Guest permissions</h2>
        {guests.length > 0 && (
          <div className="row">
            <button className="button secondary small-button" disabled={disabled} onClick={() => set("*", { playPause: true, seek: true })}>
              Allow all
            </button>
            <button className="button secondary small-button" disabled={disabled} onClick={() => set("*", { playPause: false, seek: false })}>
              Lock all
            </button>
          </div>
        )}
      </div>
      {guests.length === 0 ? (
        <p className="muted small">When guests join, choose here whether they can pause or skip.</p>
      ) : (
        <table className="permissions">
          <thead>
            <tr>
              <th>Guest</th>
              <th>Play / pause</th>
              <th>Seek / skip</th>
            </tr>
          </thead>
          <tbody>
            {guests.map((g) => (
              <tr key={g.id}>
                <td>{g.name}</td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${g.name} can play and pause`}
                    checked={g.permissions.playPause}
                    disabled={disabled}
                    onChange={(e) => set(g.id, { ...g.permissions, playPause: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${g.name} can seek`}
                    checked={g.permissions.seek}
                    disabled={disabled}
                    onChange={(e) => set(g.id, { ...g.permissions, seek: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">You can always play, pause and seek. New guests can do both until you change it.</p>
    </section>
  );
}
