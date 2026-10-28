import { useSyncExternalStore } from "react";
import { isUserLoggedIn, TAPROOT_AUTH_CHANGE_EVENT } from "../utils/auth";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(TAPROOT_AUTH_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(TAPROOT_AUTH_CHANGE_EVENT, onChange);
}

/** `isUserLoggedIn()` that re-renders on login / logout (TAPROOT_AUTH_CHANGE_EVENT). */
export function useAuthFlag(): boolean {
  return useSyncExternalStore(subscribe, isUserLoggedIn, () => false);
}
