import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";

interface PendingReceiptPageProps {
  onClose: () => void;
}

export function PendingReceiptPage({ onClose }: PendingReceiptPageProps) {
  const { t } = useLanguage();

  return (
    <SecondaryView 
      onClose={onClose} 
      title={t.profile.pendingReceipt}
      showTitle={true}
    >
      <div className="p-4">
        {/* 在这里添加待收货的内容 */}
      </div>
    </SecondaryView>
  );
}