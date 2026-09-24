import { cookies } from "next/headers";
import Link from "next/link";
import { JoinForm } from "@/components/room/JoinForm";
import { RoomView } from "@/components/room/RoomView";
import { getConfig } from "@/lib/config";
import { getRoom, publicRoom, resolveGuest } from "@/lib/rooms/hub";
import { RoomIdSchema } from "@/lib/rooms/protocol";
import { COOKIE_GUEST } from "@/lib/session/cookies";
import { getCurrentSession } from "@/lib/session/host";

/** Invite link target: join form for new guests, the live room for participants. */
export default async function RoomPage(props: PageProps<"/r/[roomId]">) {
  const { roomId } = await props.params;
  const room = RoomIdSchema.safeParse(roomId).success ? getRoom(roomId) : undefined;

  if (!room) {
    return (
      <section className="panel">
        <h2>Watch party not found</h2>
        <p className="muted">It may have ended or expired, or the link is incomplete.</p>
        <Link href="/">Go to PlexTogether</Link>
      </section>
    );
  }

  const session = await getCurrentSession();
  const isHost = session?.id === room.hostSessionId;
  const guest = isHost ? undefined : resolveGuest((await cookies()).get(COOKIE_GUEST)?.value);
  const viewerId = isHost ? room.hostParticipantId : guest?.room.id === room.id ? guest.participant.id : null;

  return (
    <div className="wide narrow">
      {viewerId ? (
        <RoomView
          initial={publicRoom(room, viewerId)}
          isHost={isHost}
          inviteUrl={`${getConfig().appOrigin}/r/${room.id}`}
        />
      ) : (
        <JoinForm roomId={room.id} title={room.title} code={room.code} />
      )}
    </div>
  );
}
