import { isDeveloperMode } from "./developerMode";
import { isServerAssignedId } from "./auth";

export function canOpenConfigManager(opts: {
  loggedIn: boolean;
  contentRole?: string | null;
  loading?: boolean;
  requireServerAssignedId?: boolean;
}): boolean {
  if (isDeveloperMode()) return true;
  if (opts.loading) return false;
  if (!opts.loggedIn) return false;
  if (opts.requireServerAssignedId !== false && !isServerAssignedId()) return false;
  return opts.contentRole === "admin" || opts.contentRole === "editor";
}
