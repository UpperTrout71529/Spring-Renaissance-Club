// /circle/anniversary (docs/tz-v2-circle.md §10, §16; D30): "A year in the
// Circle" — the member confirms or edits a US address (prefilled from the
// joining address) and presses Send my gift. Felix creates the order.

import { useEffect, useState } from "preact/hooks";
import { api } from "../../api";
import { copy } from "../../copy/en";
import { addressFromGift, checkAddress, type AddressErrors, type AnniversaryGift, type UsAddress } from "../../circle-model";
import { US_STATES } from "../../us-states";
import { EmptyState, ErrorState, Skeleton } from "../../ui/states";
import { SectionHeading } from "../Placeholder";
import { BackToCircle, errMessage, useApi } from "./shared";

const ERRORS = { required: copy.anniversary.required, state: copy.anniversary.stateError, zip: copy.anniversary.zipError };

export function Anniversary() {
  const { state, reload } = useApi<{ gift: AnniversaryGift | null }>("/api/circle/anniversary");
  const [form, setForm] = useState<UsAddress | null>(null);
  const [errors, setErrors] = useState<AddressErrors>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gift = state.kind === "ready" ? state.data.gift : null;
  useEffect(() => {
    if (gift) {
      setForm(addressFromGift(gift));
      setEditing(gift.status !== "ready");
      setSent(gift.status === "ready");
    }
  }, [gift?.id]);

  const heading = copy.anniversary.title(gift?.n ?? 1);
  if (state.kind === "loading") return <><BackToCircle /><SectionHeading eyebrow={copy.eyebrows.circle} title={heading} /><Skeleton lines={5} label={copy.anniversary.loading} /></>;
  if (state.kind === "error") return <><BackToCircle /><ErrorState body={state.message} onRetry={reload} /></>;
  if (!gift || !form) {
    return <><BackToCircle /><SectionHeading eyebrow={copy.eyebrows.circle} title={heading} /><EmptyState title={copy.anniversary.noneTitle} body={copy.anniversary.noneBody} /></>;
  }

  const set = (k: keyof UsAddress) => (e: Event) => setForm({ ...form, [k]: (e.target as HTMLInputElement | HTMLSelectElement).value });

  async function submit(e: Event) {
    e.preventDefault();
    const found = checkAddress(form!);
    setErrors(found);
    if (Object.keys(found).length) {
      document.getElementById(`addr-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const a = form!;
      await api("/api/circle/anniversary", { method: "POST", body: { address: {
        name: a.name.trim(), line1: a.line1.trim(), line2: a.line2.trim() || undefined, city: a.city.trim(),
        state: a.state.trim().toUpperCase(), postal_code: a.postal_code.trim(), country: "US",
      } } });
      setSent(true);
      setEditing(false);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (k: keyof UsAddress, label: string, opts: { autoComplete: string; optional?: boolean; inputMode?: "numeric" }) => (
    <div class="field">
      <label for={`addr-${k}`}>{label}</label>
      <input id={`addr-${k}`} value={form[k]} onInput={set(k)} autoComplete={opts.autoComplete} inputMode={opts.inputMode}
        required={!opts.optional} aria-invalid={errors[k] ? "true" : undefined} aria-describedby={errors[k] ? `addr-${k}-error` : undefined} />
      {errors[k] && <p id={`addr-${k}-error`} class="field-error">{ERRORS[errors[k]!]}</p>}
    </div>
  );

  return (
    <>
      <BackToCircle />
      <SectionHeading eyebrow={copy.eyebrows.circle} title={heading} />
      <div class="circle-intro appear">
        <p>{copy.anniversary.body}</p>
        {sent && !editing ? (
          <>
            <p class="notice" role="status">{copy.anniversary.done}</p>
            <address class="address-view">
              {form.name}<br />{form.line1}<br />{form.line2 && <>{form.line2}<br /></>}
              {`${form.city}, ${form.state} ${form.postal_code}`}<br />{copy.anniversary.us}
            </address>
            <div><button type="button" class="button-link" onClick={() => setEditing(true)}>{copy.anniversary.edit}</button></div>
          </>
        ) : (
          <form class="circle-form" onSubmit={submit} noValidate>
            {field("name", copy.anniversary.name, { autoComplete: "shipping name" })}
            {field("line1", copy.anniversary.line1, { autoComplete: "shipping address-line1" })}
            {field("line2", copy.anniversary.line2, { autoComplete: "shipping address-line2", optional: true })}
            {field("city", copy.anniversary.city, { autoComplete: "shipping address-level2" })}
            <div class="field-row">
              <div class="field">
                <label for="addr-state">{copy.anniversary.state}</label>
                <select id="addr-state" value={form.state} onChange={set("state")} autoComplete="shipping address-level1" required
                  aria-invalid={errors.state ? "true" : undefined} aria-describedby={errors.state ? "addr-state-error" : undefined}>
                  <option value="">{copy.anniversary.chooseState}</option>
                  {US_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
                {errors.state && <p id="addr-state-error" class="field-error">{ERRORS[errors.state]}</p>}
              </div>
              {field("postal_code", copy.anniversary.zip, { autoComplete: "shipping postal-code", inputMode: "numeric" })}
            </div>
            <p class="small">{`${copy.anniversary.country}: ${copy.anniversary.us}. ${copy.anniversary.usOnly}`}</p>
            {error && <p class="field-error" role="alert">{error}</p>}
            <div>
              <button type="submit" class="button button-primary" disabled={busy}>{busy ? copy.anniversary.sending : copy.anniversary.send}</button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
