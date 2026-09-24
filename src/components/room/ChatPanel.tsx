"use client";

import { useEffect, useRef, useState } from "react";
import { CHAT_MAX_LENGTH, REACTIONS, type ChatMessage, type ClientMessage } from "@/lib/rooms/protocol";

/**
 * Room chat and quick reactions. Messages are plain text and rendered as text
 * (React escapes them) — no links or HTML. The server rate-limits and trims.
 */
export function ChatPanel({
  messages,
  me,
  send,
  disabled,
}: {
  messages: ChatMessage[];
  me: string;
  send: (msg: ClientMessage) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const listRef = useRef<HTMLOListElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    send({ type: "chat", text: t.slice(0, CHAT_MAX_LENGTH) });
    setText("");
  }

  return (
    <section className="panel chat">
      <h2>Chat</h2>
      <div className="reactions-bar" role="group" aria-label="Reactions">
        {REACTIONS.map((emoji) => (
          <button
            key={emoji}
            className="reaction-button"
            onClick={() => send({ type: "react", emoji })}
            disabled={disabled}
            aria-label={`React ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
      <ol className="chat-list" ref={listRef} aria-live="polite">
        {messages.length === 0 && <li className="muted small chat-empty">No messages yet — say hi 👋</li>}
        {messages.map((m) => (
          <li key={m.id} className={m.from === me ? "chat-msg mine" : "chat-msg"}>
            <span className="chat-name">{m.from === me ? "You" : m.name}</span>
            <span className="chat-text">{m.text}</span>
          </li>
        ))}
      </ol>
      <form className="row" onSubmit={submit}>
        <input
          aria-label="Message"
          placeholder="Message"
          value={text}
          maxLength={CHAT_MAX_LENGTH}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
        />
        <button className="button" type="submit" disabled={disabled || !text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
