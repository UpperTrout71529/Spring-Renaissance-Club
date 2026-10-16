// /circle/rooms — Your rooms, the Spatial Profile (spec v1.1 T13; D36). A
// photo is re-encoded in the browser through a canvas to JPEG — which drops
// EXIF (location, camera) — and PUT to the Worker with its room label. The
// server refuses a file that still has EXIF. Without R2 it answers 503
// rooms_unavailable, and the page says so calmly.

import { useState } from "preact/hooks";
import { api, API_BASE, ApiError } from "../../api";
import { copy } from "../../copy/en";
import { formatDate } from "../../format";
import { fitWithin, type RoomPhoto } from "../../circle-model";
import { EmptyState, ErrorState, Skeleton } from "../../ui/states";
import { SectionHeading } from "../Placeholder";
import { BackToCircle, errMessage, useApi } from "./shared";

// Decodes any image the browser can read and draws it on a canvas; the JPEG
// that comes out carries pixels only. createImageBitmap needs no URL, so the
// page's CSP stays as it is (no blob: images).
export async function reencodeJpeg(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!blob) throw new Error("no blob");
    return blob;
  } finally {
    bitmap.close?.();
  }
}

export function Rooms() {
  const { state, reload, refresh } = useApi<{ photos: RoomPhoto[] }>("/api/circle/rooms");
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: "label" | "file"; text: string } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const isUnavailable = (e: unknown) => e instanceof ApiError && e.status === 503 && e.code === "rooms_unavailable";

  async function upload(e: Event) {
    e.preventDefault();
    if (!label.trim()) return setError({ field: "label", text: copy.rooms.needRoom });
    if (!file) return setError({ field: "file", text: copy.rooms.needPhoto });
    setBusy(true);
    setError(null);
    let jpeg: Blob;
    try {
      jpeg = await reencodeJpeg(file);
    } catch {
      setBusy(false);
      return setError({ field: "file", text: copy.rooms.unreadable });
    }
    try {
      await api(`/api/circle/rooms?label=${encodeURIComponent(label.trim())}`, { method: "PUT", body: jpeg });
      setLabel("");
      setFile(null);
      setInputKey((k) => k + 1);
      await refresh();
    } catch (err) {
      if (isUnavailable(err)) setUnavailable(true);
      else setError({ text: errMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api(`/api/circle/rooms/${encodeURIComponent(id)}`, { method: "DELETE" });
      setConfirming(null);
      await refresh();
    } catch (err) {
      if (isUnavailable(err)) setUnavailable(true);
      else setError({ text: errMessage(err) });
    }
  }

  const off = unavailable || (state.kind === "error" && state.status === 503);

  return (
    <>
      <BackToCircle />
      <SectionHeading eyebrow={copy.rooms.eyebrow} title={copy.rooms.title} />
      <div class="circle-intro"><p>{copy.rooms.lede}</p></div>
      {off && <p class="notice circle-notice" role="status">{copy.rooms.unavailable}</p>}
      {!off && state.kind === "loading" && <Skeleton lines={3} label={copy.rooms.loading} />}
      {!off && state.kind === "error" && <ErrorState body={state.message} onRetry={reload} />}
      {state.kind === "ready" && state.data.photos.length === 0 && !off && <EmptyState title={copy.rooms.emptyTitle} body={copy.rooms.emptyBody} />}
      {state.kind === "ready" && state.data.photos.length > 0 && (
        <ul class="rooms-grid appear">
          {state.data.photos.map((p) => (
            <li key={p.id} class="room">
              <img src={`${API_BASE}/api/circle/rooms/${encodeURIComponent(p.id)}/image`} alt={copy.rooms.photoAlt(p.room_label)} loading="lazy" width={400} height={300} />
              <span>{p.room_label}</span>
              <span class="small">{copy.rooms.added(formatDate(p.created_at))}</span>
              {confirming === p.id ? (
                <div class="room-actions" role="group" aria-label={copy.rooms.confirmRemove}>
                  <span class="small">{copy.rooms.confirmRemove}</span>
                  <button type="button" class="button-link danger-link" onClick={() => remove(p.id)}>{copy.rooms.remove}</button>
                  <button type="button" class="button-link" onClick={() => setConfirming(null)}>{copy.rooms.keep}</button>
                </div>
              ) : (
                <div class="room-actions">
                  <button type="button" class="button-link" aria-label={copy.rooms.removeLabel(p.room_label)} onClick={() => setConfirming(p.id)}>{copy.rooms.remove}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.kind === "ready" && !off && (
        <form class="circle-form" onSubmit={upload} noValidate aria-labelledby="rooms-add">
          <h2 id="rooms-add">{copy.rooms.addTitle}</h2>
          <div class="field">
            <label for="room-label">{copy.rooms.room}</label>
            <input id="room-label" list="room-suggestions" maxLength={60} value={label}
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              aria-invalid={error?.field === "label" ? "true" : undefined}
              aria-describedby={error?.field === "label" ? "room-hint room-error" : "room-hint"} />
            <datalist id="room-suggestions">
              {copy.rooms.roomSuggestions.map((s) => <option key={s} value={s} />)}
            </datalist>
            <p id="room-hint" class="field-hint">{copy.rooms.roomHint}</p>
            {error?.field === "label" && <p id="room-error" class="field-error" role="alert">{error.text}</p>}
          </div>
          <div class="field">
            <label for="room-file">{copy.rooms.photo}</label>
            <input key={inputKey} id="room-file" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)}
              aria-invalid={error?.field === "file" ? "true" : undefined}
              aria-describedby={error?.field === "file" ? "room-privacy room-file-error" : "room-privacy"} />
            <p id="room-privacy" class="field-hint">{copy.rooms.privacy}</p>
            {error?.field === "file" && <p id="room-file-error" class="field-error" role="alert">{error.text}</p>}
          </div>
          {error && !error.field && <p class="field-error" role="alert">{error.text}</p>}
          <div><button type="submit" class="button button-primary" disabled={busy}>{busy ? copy.rooms.uploading : copy.rooms.upload}</button></div>
        </form>
      )}
    </>
  );
}
