import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";

interface PendingPaymentPageProps {
  onClose: () => void;
}

export function PendingPaymentPage({ onClose }: PendingPaymentPageProps) {
  const { t } = useLanguage();

  return (
    <SecondaryView 
      onClose={onClose} 
      title={t.profile.pendingPayment}
      showTitle={true}
    >
      <div className="p-4">
        {/* 在这里添加待付款的内容 */}
      </div>
    </SecondaryView>
  );
}