import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";

interface InvoiceRecordsPageProps {
  onClose: () => void;
}

export function InvoiceRecordsPage({ onClose }: InvoiceRecordsPageProps) {
  const { t } = useLanguage();

  return (
    <SecondaryView 
      onClose={onClose} 
      title={t.profile.invoiceRecords}
      showTitle={true}
    >
      <div className="p-4">
        {/* 在这里添加发票记录的内容 */}
      </div>
    </SecondaryView>
  );
}