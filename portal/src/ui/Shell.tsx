// App shell (spec §5.4): one navigation landmark that is a 5-item bottom tab
// bar below 1024px and a 240px left column from 1024px up. Active item:
// aria-current, a filled icon and a 2px line (above it on mobile).

import type { ComponentChildren } from "preact";
import { House, Package, Heart, Stamp, User, LogOut } from "lucide-preact";
import { copy } from "../copy/en";
import type { RouteName } from "../router";
import { Link } from "./Link";
import { OfflineBanner } from "./states";
import "./shell.css";

type Tab = { key: string; href: string; label: string; Icon: typeof House; routes: RouteName[] };

const TABS: Tab[] = [
  { key: "home", href: "/", label: copy.nav.home, Icon: House, routes: ["home"] },
  { key: "orders", href: "/orders", label: copy.nav.orders, Icon: Package, routes: ["orders", "order"] },
  { key: "saved", href: "/saved", label: copy.nav.saved, Icon: Heart, routes: ["saved"] },
  { key: "circle", href: "/circle", label: copy.nav.circle, Icon: Stamp, routes: ["circle"] },
  { key: "account", href: "/account", label: copy.nav.account, Icon: User, routes: ["account", "accountSecurity", "accountPrivacy"] },
];

type Props = {
  route: RouteName;
  email: string;
  circleBadge?: boolean;
  onSignOut: () => void;
  children: ComponentChildren;
};

export function Shell({ route, email, circleBadge = false, onSignOut, children }: Props) {
  return (
    <div class="shell">
      <a class="skip-link" href="#main">{copy.skipToContent}</a>
      <nav class="nav" aria-label={copy.nav.label}>
        <div class="nav-brand" aria-hidden="true">{copy.brand}</div>
        <ul class="nav-list">
          {TABS.map(({ key, href, label, Icon, routes }) => {
            const active = routes.includes(route);
            return (
              <li key={key}>
                <Link href={href} class="nav-item" aria-current={active ? "page" : undefined}>
                  <span class="nav-icon">
                    <Icon size={24} strokeWidth={active ? 1.75 : 1.5} aria-hidden="true" class={active ? "is-filled" : undefined} />
                    {key === "circle" && circleBadge && <span class="nav-dot" aria-hidden="true" />}
                  </span>
                  <span class="nav-label">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div class="nav-foot">
          <span class="nav-email small">{email}</span>
          <button type="button" class="button-link nav-signout" onClick={onSignOut}>
            <LogOut size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>{copy.nav.signOut}</span>
          </button>
        </div>
      </nav>
      <div class="shell-body">
        <OfflineBanner />
        <main id="main" class="content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}

export function PublicLayout({ children }: { children: ComponentChildren }) {
  return (
    <div class="public">
      <OfflineBanner />
      <main id="main" class="public-main" tabIndex={-1}>{children}</main>
    </div>
  );
}
