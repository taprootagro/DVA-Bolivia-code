import { Camera, MapPin, Mic } from 'lucide-react';
import { Switch } from './ui/switch';
import { useLanguage } from '../hooks/useLanguage';
import { useAppPermissions } from '../hooks/useAppPermissions';
import {
  type PermissionKind,
  type PermissionOsState,
  openSystemPermissionSettings,
  requestPermission,
  setAppPermissionEnabled,
} from '../utils/appPermissions';
import { toast } from '../utils/capacitor-bridge';

const KIND_META: Record<
  PermissionKind,
  { icon: typeof Camera; labelKey: 'permissionsCamera' | 'permissionsMicrophone' | 'permissionsLocation' }
> = {
  camera: { icon: Camera, labelKey: 'permissionsCamera' },
  microphone: { icon: Mic, labelKey: 'permissionsMicrophone' },
  location: { icon: MapPin, labelKey: 'permissionsLocation' },
};

function osLabel(os: PermissionOsState, p: ReturnType<typeof useLanguage>['t']['settings']): string {
  if (os === 'granted') return p.permissionsOsGranted;
  if (os === 'denied') return p.permissionsOsDenied;
  if (os === 'prompt') return p.permissionsOsPrompt;
  return p.permissionsOsUnsupported;
}

export function PermissionsSettingsPanel() {
  const { t } = useLanguage();
  const p = t.settings;
  const { snapshots, loading, refresh } = useAppPermissions();

  const handleAppToggle = (kind: PermissionKind, enabled: boolean) => {
    setAppPermissionEnabled(kind, enabled);
    void refresh();
  };

  const handleReRequest = async (kind: PermissionKind) => {
    setAppPermissionEnabled(kind, true);
    await requestPermission(kind);
    await refresh();
  };

  const handleOpenSystem = async () => {
    const result = await openSystemPermissionSettings();
    if (result === 'web_hint') {
      await toast.show({ text: p.permissionsWebSettingsHint, duration: 'long', position: 'bottom' });
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 leading-relaxed">{p.permissionsAppDisabledHint}</p>
      {loading && snapshots.length === 0 ? (
        <p className="text-xs text-gray-400 py-2">{t.common.loading}</p>
      ) : (
        snapshots.map((snap) => {
          const meta = KIND_META[snap.kind];
          const Icon = meta.icon;
          const label = p[meta.labelKey];
          return (
            <div key={snap.kind} className="bg-white rounded-xl p-3 border border-gray-100">
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4 text-emerald-600" />
                <span className="text-sm font-medium text-gray-900">{label}</span>
                <span className="ms-auto text-xs text-gray-500">{osLabel(snap.os, p)}</span>
              </div>
              <div className="flex items-center justify-between gap-2 py-1">
                <span className="text-xs text-gray-600">{p.permissionsAppEnabled}</span>
                <Switch
                  checked={snap.appEnabled}
                  onCheckedChange={(v) => handleAppToggle(snap.kind, v)}
                />
              </div>
              {(snap.os === 'prompt' || !snap.appEnabled) && (
                <button
                  type="button"
                  onClick={() => void handleReRequest(snap.kind)}
                  className="mt-2 text-xs text-emerald-700 font-medium active:opacity-70"
                >
                  {p.permissionsReRequest}
                </button>
              )}
            </div>
          );
        })
      )}
      <button
        type="button"
        onClick={() => void handleOpenSystem()}
        className="w-full py-2.5 rounded-xl bg-emerald-50 text-emerald-800 text-sm font-medium active:bg-emerald-100"
      >
        {p.permissionsOpenSystem}
      </button>
    </div>
  );
}
