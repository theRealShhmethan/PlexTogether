"use client";

import { useState } from "react";
import { getJson, postJson } from "@/lib/client/api";
import type { SubtitleResult, Tracks } from "@/lib/plex/tracks";

const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["it", "Italiano"],
  ["pt", "Português"],
  ["nl", "Nederlands"],
  ["sv", "Svenska"],
  ["no", "Norsk"],
  ["da", "Dansk"],
  ["fi", "Suomi"],
  ["pl", "Polski"],
  ["tr", "Türkçe"],
  ["ru", "Русский"],
  ["ar", "العربية"],
  ["he", "עברית"],
  ["hi", "हिन्दी"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["zh", "中文"],
  ["vi", "Tiếng Việt"],
  ["th", "ไทย"],
  ["id", "Bahasa Indonesia"],
  ["el", "Ελληνικά"],
];

type DownloadResponse = { ok: true; tracks: Tracks; newTrackId: number | null };

/**
 * "Find subtitles": searches online through Plex (like Plex's own apps) and
 * downloads the chosen one onto the item. The browser only sends a result's
 * index; the server keeps the real keys.
 */
export function SubtitleSearch({
  apiBase,
  onDownloaded,
  onClose,
}: {
  apiBase: string;
  onDownloaded: (tracks: Tracks, newTrackId: number | null) => Promise<void>;
  onClose: () => void;
}) {
  const [language, setLanguage] = useState("en");
  const [sdh, setSdh] = useState(false);
  const [results, setResults] = useState<SubtitleResult[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setError(null);
    setResults(null);
    setStatus("Searching…");
    const r = await getJson<{ results: SubtitleResult[] }>(
      `${apiBase}/subtitles?${new URLSearchParams({ language, sdh: sdh ? "1" : "0" })}`,
    );
    setBusy(false);
    setStatus(null);
    if (r.ok) setResults(r.data.results);
    else setError(r.error);
  }

  async function download(index: number) {
    setBusy(true);
    setError(null);
    setStatus("Downloading — Plex is adding it to the movie…");
    const r = await postJson<DownloadResponse>(`${apiBase}/subtitles`, { index });
    if (!r.ok) {
      setBusy(false);
      setStatus(null);
      setError(r.error);
      return;
    }
    if (r.data.newTrackId === null) {
      setBusy(false);
      setStatus("Plex is still downloading it. Check the subtitle list again in a moment.");
      await onDownloaded(r.data.tracks, null);
      return;
    }
    setStatus("Added — switching to it…");
    await onDownloaded(r.data.tracks, r.data.newTrackId);
    setBusy(false);
  }

  return (
    <div className="subtitle-search">
      <div className="page-header">
        <strong>Find subtitles</strong>
        <button className="link-button small" onClick={onClose}>
          Back
        </button>
      </div>
      <div className="row">
        <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy} aria-label="Language">
          {LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <button className="button small-button" onClick={() => void search()} disabled={busy}>
          Search
        </button>
      </div>
      <label className="check small muted">
        <input type="checkbox" checked={sdh} onChange={(e) => setSdh(e.target.checked)} disabled={busy} /> Prefer SDH
        (for the hard of hearing)
      </label>

      {status && <p className="muted small">{status}</p>}
      {error && <p className="error small">{error}</p>}
      {results && results.length === 0 && <p className="muted small">Nothing found for this language.</p>}
      {results && results.length > 0 && (
        <ul className="subtitle-results">
          {results.map((r, i) => (
            <li key={i}>
              <div className="subtitle-info">
                <span className="subtitle-title" title={r.title}>
                  {r.title}
                </span>
                <span className="muted small">
                  {[
                    r.provider,
                    r.perfectMatch ? "exact match" : null,
                    r.hearingImpaired ? "SDH" : null,
                    r.forced ? "forced" : null,
                    r.score !== null ? `score ${r.score}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <button className="button secondary small-button" onClick={() => void download(i)} disabled={busy}>
                Get
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Downloaded subtitles are added to the title on the Plex server, like in Plex.</p>
    </div>
  );
}
