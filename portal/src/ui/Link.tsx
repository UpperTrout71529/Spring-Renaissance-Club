import type { ComponentChildren } from "preact";
import { navigate } from "../router";

type Props = {
  href: string;
  class?: string;
  "aria-current"?: "page";
  children: ComponentChildren;
};

// An ordinary <a> that routes in-app on a plain left click and leaves
// modified clicks (new tab, etc.) to the browser.
export function Link({ href, children, ...rest }: Props) {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={onClick} {...rest}>{children}</a>;
}
