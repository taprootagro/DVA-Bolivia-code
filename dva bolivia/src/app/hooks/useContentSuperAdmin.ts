import { useEdgeProfile } from "./useEdgeProfile";

/**
 * Whether the current session is a content super-admin or editor (Edge GET /profile → contentRole).
 */
export function useContentSuperAdmin() {
  const { contentSuperAdmin, contentRole, loading, error, refresh } = useEdgeProfile();
  return { contentSuperAdmin, contentRole, loading, error, refresh };
}
