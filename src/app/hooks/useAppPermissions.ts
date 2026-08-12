import { useCallback, useEffect, useState } from 'react';
import {
  type PermissionKind,
  type PermissionSnapshot,
  queryAllPermissions,
  subscribeAppPrefChanges,
} from '../utils/appPermissions';

export function useAppPermissions() {
  const [snapshots, setSnapshots] = useState<PermissionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await queryAllPermissions();
      setSnapshots(next);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubPref = subscribeAppPrefChanges(() => {
      void refresh();
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onPageShow = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      unsubPref();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [refresh]);

  const getSnapshot = useCallback(
    (kind: PermissionKind): PermissionSnapshot | undefined =>
      snapshots.find((s) => s.kind === kind),
    [snapshots],
  );

  return { snapshots, loading, refresh, getSnapshot };
}
