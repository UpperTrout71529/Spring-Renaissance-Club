// /account (spec §6.8): profile, email (change with step-up), emails
// (transactional note + the seasonal letter switch), links, sign out.

import { useEffect, useState } from "preact/hooks";
import { api, ApiError, type Me } from "../api";
import { copy } from "../copy/en";
import { STOREFRONT_ORIGIN } from "../router";
import { Link } from "../ui/Link";
import { Skeleton } from "../ui/states";
import { useStepUp } from "../ui/useStepUp";
import { SectionHeading } from "./Placeholder";
import "./security.css";

const errMessage = (e: unknown) => (e instanceof ApiError ? e.message : copy.errors.generic);

export function Account({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { api<Me>("/api/me").then(setMe).catch(() => {}); }, []);

  return (
    <>
      <SectionHeading title={copy.nav.account} />
      {me ? (
        <>
          <Profile me={me} onSaved={setMe} />
          <EmailSection email={me.user.email} />
          <Emails me={me} onSaved={setMe} />
        </>
      ) : <Skeleton lines={4} label={copy.nav.account} />}
      <ul class="account-links">
        {me?.user.tier === "vip" && <li><Link href="/account/membership">{copy.membership.title}</Link></li>}
        <li><Link href="/account/security">{copy.account.security}</Link></li>
        <li><Link href="/account/privacy">{copy.account.privacy}</Link></li>
        <li><a href={`${STOREFRONT_ORIGIN}/policies/privacy-policy`}>{copy.account.privacyPolicy}</a></li>
        <li><a href="mailto:concierge@springrenaissance.store">{copy.account.contact}</a></li>
        <li><button type="button" class="button-link" onClick={onSignOut}>{copy.nav.signOut}</button></li>
      </ul>
      <p class="small account-email">{email}</p>
    </>
  );
}

function Profile({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const [first, setFirst] = useState(me.user.first_name ?? "");
  const [last, setLast] = useState(me.user.last_name ?? "");
  const [state, setState] = useState<"idle" | "busy" | "saved" | { error: string }>("idle");

  async function save(e: Event) {
    e.preventDefault();
    setState("busy");
    try {
      onSaved(await api<Me>("/api/me", { method: "PATCH", body: { first_name: first, last_name: last } }));
      setState("saved");
    } catch (err) {
      setState({ error: errMessage(err) });
    }
  }

  return (
    <section class="account-section" aria-labelledby="profile-title">
      <h2 id="profile-title">{copy.account.profile}</h2>
      <form class="account-form" onSubmit={save} noValidate>
        <div class="field">
          <label for="first-name">{copy.account.firstName}</label>
          <input id="first-name" autoComplete="given-name" maxLength={80} value={first}
            onInput={(e) => setFirst((e.target as HTMLInputElement).value)} />
        </div>
        <div class="field">
          <label for="last-name">{copy.account.lastName}</label>
          <input id="last-name" autoComplete="family-name" maxLength={80} value={last}
            onInput={(e) => setLast((e.target as HTMLInputElement).value)} />
        </div>
        <div class="account-actions">
          <button type="submit" class="button button-secondary" disabled={state === "busy"}>{copy.account.saveProfile}</button>
          {state === "saved" && <span class="small" role="status">{copy.account.profileSaved}</span>}
        </div>
        {typeof state === "object" && <p class="field-error" role="alert">{state.error}</p>}
      </form>
      <p class="small">{copy.account.addresses}</p>
    </section>
  );
}

function EmailSection({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { run, dialog } = useStepUp(email);

  async function send(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const done = await run(() => api("/api/me/email-change", { method: "POST", body: { new_email: value.trim() } }).then(() => true));
      if (done) {
        setSentTo(value.trim());
        setOpen(false);
      }
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="account-section" aria-labelledby="email-title">
      <h2 id="email-title">{copy.account.email}</h2>
      <p>{email}</p>
      {sentTo && <p class="notice" role="status">{copy.account.emailSent(sentTo)}</p>}
      {!open ? (
        <button type="button" class="button-link" onClick={() => { setOpen(true); setSentTo(null); }}>{copy.account.changeEmail}</button>
      ) : (
        <form class="account-form" onSubmit={send} noValidate>
          <div class="field">
            <label for="new-email">{copy.account.newEmail}</label>
            <input id="new-email" type="email" autoComplete="email" value={value}
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
              aria-invalid={error ? "true" : undefined} aria-describedby={error ? "new-email-error" : undefined} />
            {error && <p id="new-email-error" class="field-error" role="alert">{error}</p>}
          </div>
          <div class="account-actions">
            <button type="submit" class="button button-secondary" disabled={busy}>{copy.account.sendLink}</button>
            <button type="button" class="button-link" onClick={() => { setOpen(false); setError(null); }}>{copy.account.cancel}</button>
          </div>
        </form>
      )}
      {dialog}
    </section>
  );
}

function Emails({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  // Optimistic: the switch moves at once and returns if the save fails.
  const [on, setOn] = useState(!!me.user.seasonal_email_opt_in);
  const [busy, setBusy] = useState(false);
  async function toggle(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    setOn(checked);
    setBusy(true);
    try {
      onSaved(await api<Me>("/api/me", { method: "PATCH", body: { seasonal_email_opt_in: checked } }));
    } catch {
      setOn(!checked);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section class="account-section" aria-labelledby="emails-title">
      <h2 id="emails-title">{copy.account.emails}</h2>
      <p class="small">{copy.account.transactional}</p>
      <label class="switch">
        <input type="checkbox" checked={on} disabled={busy} onChange={toggle} />
        <span>{copy.account.seasonalLabel}</span>
      </label>
    </section>
  );
}
