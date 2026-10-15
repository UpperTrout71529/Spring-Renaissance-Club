// Every UI string lives here (spec §3.4, §6.9) — no copy in markup.
// Texts quoted in the spec are used verbatim; anything else is marked in the PR.

export const copy = {
  brand: "Spring Renaissance",
  skipToContent: "Skip to content",
  nav: {
    label: "Main",
    home: "Home",
    orders: "Orders",
    saved: "Saved",
    circle: "Circle",
    account: "Account",
    signOut: "Sign out",
  },
  eyebrows: {
    orders: "Transfers to residence",
    saved: "Private Registry",
    circle: "The Renaissance Circle",
  },
  login: {
    title: "Your account",
    lede: "Orders, saved pieces and the Circle, in one place.",
    emailLabel: "Email address",
    submit: "Email me a sign-in link",
    sending: "Sending…",
    newHere: "New here? The same link creates your account.",
    invalidEmail: "Please enter a valid email address.",
    checkInbox: "Check your inbox",
    sentTo: (email: string) => ({ before: "We sent a sign-in link to ", email, after: ". It works for 15 minutes." }),
    differentEmail: "Use a different email",
    resend: "Resend link",
    resendIn: (seconds: number) => `Resend link in ${seconds} s`,
    resent: "We sent a fresh link.",
  },
  auth: {
    signingIn: "Signing you in…",
    expiredTitle: "This link has expired",
    expiredBody: "Sign-in links work once and for 15 minutes. We can send a fresh one.",
    sendNew: "Send a new link",
  },
  errors: {
    rateLimited: "Too many requests. Please wait a few minutes and try again.",
    network: "We couldn't reach Spring Renaissance. Check your connection and try again.",
    generic: "Something went wrong. Please try again.",
    tryAgain: "Try again",
    errorTitle: "Something went wrong",
  },
  offline: "You're offline. Some things may be out of date.",
  notFound: {
    title: "Page not found",
    body: "This page doesn't exist or has moved.",
    action: "Go to Home",
  },
  home: {
    welcomeBack: "Welcome back",
  },
};
