import { Camera, MapPin, Mic } from 'lucide-react';
import { useLanguage } from '../hooks/useLanguage';

type Props = {
  open: boolean;
  onContinue: () => void;
  onLater: () => void;
};

export function PermissionsIntroSheet({ open, onContinue, onLater }: Props) {
  const { t } = useLanguage();
  const p = t.settings;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-end justify-center sm:items-center px-4 pb-6 sm:pb-0">
      <div className="absolute inset-0 bg-black/45" aria-hidden />
      <div
        className="relative w-full max-w-sm bg-white rounded-3xl p-6 shadow-2xl"
        role="dialog"
        aria-labelledby="permissions-intro-title"
        style={{ animation: 'fadeScaleIn 200ms ease-out' }}
      >
        <h2 id="permissions-intro-title" className="text-lg font-semibold text-gray-900 text-center mb-2">
          {p.permissionsIntroTitle}
        </h2>
        <p className="text-sm text-gray-500 text-center mb-5">{p.permissionsIntroSubtitle}</p>
        <ul className="space-y-3 mb-6">
          <li className="flex items-start gap-3 text-sm text-gray-700">
            <Camera className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <span>{p.permissionsIntroLineCamera}</span>
          </li>
          <li className="flex items-start gap-3 text-sm text-gray-700">
            <Mic className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <span>{p.permissionsIntroLineMic}</span>
          </li>
          <li className="flex items-start gap-3 text-sm text-gray-700">
            <MapPin className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <span>{p.permissionsIntroLineLocation}</span>
          </li>
        </ul>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onContinue}
            className="w-full py-3 rounded-2xl bg-emerald-600 text-white text-sm font-medium active:bg-emerald-700"
          >
            {p.permissionsIntroContinue}
          </button>
          <button
            type="button"
            onClick={onLater}
            className="w-full py-3 rounded-2xl bg-gray-100 text-gray-600 text-sm font-medium active:bg-gray-200"
          >
            {p.permissionsIntroLater}
          </button>
        </div>
      </div>
    </div>
  );
}
