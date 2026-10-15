// /account (spec §6.8). S4 brings Sign-in & security; profile, emails and
// privacy arrive with S9. Sign out is here too, because on mobile the left
// column (where it lives on desktop) is a tab bar.

import { copy } from "../copy/en";
import { Link } from "../ui/Link";
import { SectionHeading } from "./Placeholder";
import "./security.css";

export function Account({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  return (
    <>
      <SectionHeading title={copy.nav.account} />
      <p class="account-email">{email}</p>
      <ul class="account-links">
        <li><Link href="/account/security">{copy.account.security}</Link></li>
        <li><button type="button" class="button-link" onClick={onSignOut}>{copy.nav.signOut}</button></li>
      </ul>
    </>
  );
}
