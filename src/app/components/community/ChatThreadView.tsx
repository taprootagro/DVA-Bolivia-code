import { type ReactNode, type RefObject } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { ChatMessage } from "../../services/ChatProxyService";
import { ChatInputBar } from "./ChatInputBar";
import { ImageViewer } from "./ImageViewer";
import { MockModeBanner } from "../MockModeBanner";

function VirtuosoHeader() {
  return <div className="h-2" />;
}

function VirtuosoFooter() {
  return <div className="h-2" />;
}

const virtuosoComponents = { Header: VirtuosoHeader, Footer: VirtuosoFooter };

export type ChatThreadViewProps = {
  chatMessages: ChatMessage[];
  firstItemIndex: number;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  renderItem: (index: number, msg: ChatMessage) => ReactNode;
  onStartReached: () => void;
  realtimeError: string | null;
  showChatMockBanner: boolean;
  viewingImage: string | null;
  onCloseImage: () => void;
  onSendText: (text: string) => void;
  onSendVoice: (duration: number, audioBlob: Blob) => void;
  onSendImage: (base64: string) => void;
  onCall: (type: "audio" | "video") => void;
  isSending: boolean;
  callsEnabled: boolean;
  readOnly?: boolean;
  /** Store blocked-thread hint, farmer-specific chrome, etc. */
  belowList?: ReactNode;
  className?: string;
};

/** Shared Virtuoso thread + input bar used by farmer CommunityPage and store shell. */
export function ChatThreadView({
  chatMessages,
  firstItemIndex,
  virtuosoRef,
  renderItem,
  onStartReached,
  realtimeError,
  showChatMockBanner,
  viewingImage,
  onCloseImage,
  onSendText,
  onSendVoice,
  onSendImage,
  onCall,
  isSending,
  callsEnabled,
  readOnly,
  belowList,
  className = "flex-1 bg-white flex flex-col overflow-hidden min-h-0",
}: ChatThreadViewProps) {
  return (
    <div className={className}>
      {viewingImage && (
        <ImageViewer src={viewingImage} onClose={onCloseImage} />
      )}
      {showChatMockBanner && <MockModeBanner feature="chat" />}
      {realtimeError && (
        <div className="px-3 py-2 bg-red-50 border-b border-red-100 text-red-800 text-xs">
          {realtimeError}
        </div>
      )}
      <div className="flex-1 px-4 py-4 min-h-0">
        <Virtuoso
          ref={virtuosoRef}
          data={chatMessages}
          firstItemIndex={firstItemIndex}
          computeItemKey={(_index, msg) => msg.id}
          initialTopMostItemIndex={Math.max(0, chatMessages.length - 1)}
          components={virtuosoComponents}
          itemContent={renderItem}
          followOutput="smooth"
          alignToBottom
          startReached={onStartReached}
        />
      </div>
      {belowList}
      <ChatInputBar
        onSendText={onSendText}
        onSendVoice={onSendVoice}
        onSendImage={onSendImage}
        onCall={onCall}
        isSending={isSending}
        callsEnabled={callsEnabled}
        adjoinDock
        readOnly={readOnly}
      />
    </div>
  );
}
