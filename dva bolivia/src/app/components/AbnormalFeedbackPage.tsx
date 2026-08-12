import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";

interface AbnormalFeedbackPageProps {
  onClose: () => void;
}

export function AbnormalFeedbackPage({ onClose }: AbnormalFeedbackPageProps) {
  const { t } = useLanguage();

  return (
    <SecondaryView 
      onClose={onClose} 
      title={t.profile.abnormalFeedback}
      showTitle={true}
    >
      <div className="p-4">
        {/* 在这里添加异常反馈的内容 */}
      </div>
    </SecondaryView>
  );
}