// Runs an API action; if the API answers 403 step_up_required (spec §10.4),
// shows the step-up dialog and retries the action once confirmed.

import { useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { StepUpDialog } from "./StepUpDialog";

type Pending = { hasPasskeys: boolean; confirm: () => void; cancel: () => void };

export function useStepUp(email: string) {
  const [pending, setPending] = useState<Pending | null>(null);

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "step_up_required")) throw e;
      let hasPasskeys = false;
      try {
        hasPasskeys = (await api<{ passkeys: unknown[] }>("/api/passkeys")).passkeys.length > 0;
      } catch {
        // No list: offer the emailed code only.
      }
      return new Promise<T | undefined>((resolve, reject) => {
        setPending({
          hasPasskeys,
          confirm: () => {
            setPending(null);
            action().then(resolve, reject);
          },
          cancel: () => {
            setPending(null);
            resolve(undefined);
          },
        });
      });
    }
  }

  const dialog = pending
    ? <StepUpDialog email={email} hasPasskeys={pending.hasPasskeys} onConfirmed={pending.confirm} onCancel={pending.cancel} />
    : null;
  return { run, dialog };
}
