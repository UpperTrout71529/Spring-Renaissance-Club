import type { ComponentChildren } from "preact";
import { navigate } from "../router";

type Props = {
  href: string;
  class?: string;
  "aria-current"?: "page";
  // Runs on every click, before in-app navigation (e.g. analytics).
  onClick?: () => void;
  children: ComponentChildren;
};

// An ordinary <a> that routes in-app on a plain left click and leaves
// modified clicks (new tab, etc.) to the browser.
export function Link({ href, children, onClick: onAnyClick, ...rest }: Props) {
  const onClick = (e: MouseEvent) => {
    onAnyClick?.();
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={onClick} {...rest}>{children}</a>;
}
