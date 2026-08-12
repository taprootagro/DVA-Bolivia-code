import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";

interface AllOrdersPageProps {
  onClose: () => void;
}

export function AllOrdersPage({ onClose }: AllOrdersPageProps) {
  const { t } = useLanguage();

  return (
    <SecondaryView 
      onClose={onClose} 
      title={t.profile.allOrders}
      showTitle={true}
    >
      <div className="p-4">
        {/* 在这里添加所有订单的内容 */}
      </div>
    </SecondaryView>
  );
}