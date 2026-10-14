type ApprovalDiscoveryOptions = {
  claim: () => Promise<string | null>;
  onClaim: (requestId: string) => void;
  onError: (error: unknown | null) => void;
  focusTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
};

// An action popup can already be open when a website submits its request. Keep
// checking until a claim is made, then leave that claim alone during approval,
// onboarding and unlock. Never overlap messages or revive a disposed popup.
export function watchApproval({ claim, onClaim, onError, focusTarget }: ApprovalDiscoveryOptions) {
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    focusTarget.removeEventListener('focus', retry);
  };
  const check = async () => {
    if (stopped || inFlight) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    inFlight = true;
    try {
      const requestId = await claim();
      if (stopped) return;
      onError(null);
      if (requestId) {
        stop();
        onClaim(requestId);
      }
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      inFlight = false;
      if (!stopped) timer = setTimeout(retry, 1_500);
    }
  };
  function retry() { void check(); }

  focusTarget.addEventListener('focus', retry);
  retry();
  return { retry, stop };
}
