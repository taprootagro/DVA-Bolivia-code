import { useState, useRef, useCallback, type ReactNode, type DragEvent } from 'react';
import { GripVertical } from 'lucide-react';

export interface SortableItem {
  id: string | number;
  [key: string]: unknown;
}

interface SortableListProps<T extends SortableItem> {
  items: T[];
  onReorder: (newItems: T[]) => void;
  renderItem: (item: T, index: number, isDragging: boolean) => ReactNode;
  itemKey?: (item: T, index: number) => string;
  className?: string;
  /** 是否显示拖拽手柄。grid 模式下设为 false，整卡可拖拽 */
  showHandle?: boolean;
}

/**
 * SortableList — 通用拖拽排序列表组件
 *
 * 使用 HTML5 Drag and Drop API 实现轻量级拖拽重排。
 * 提供视觉反馈：拖拽半透明 + 插入指示线。
 * showHandle=false 时整卡可拖拽（适用于卡片网格布局）。
 */
export default function SortableList<T extends SortableItem>({
  items,
  onReorder,
  renderItem,
  itemKey,
  className = '',
  showHandle = true,
}: SortableListProps<T>) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragNode = useRef<HTMLElement | null>(null);

  const getKey = useCallback(
    (item: T, idx: number) =>
      itemKey ? itemKey(item, idx) : `${String(item.id ?? 'noid')}-${idx}`,
    [itemKey],
  );

  const handleDragStart = useCallback(
    (e: DragEvent<HTMLDivElement>, index: number) => {
      dragNode.current = e.currentTarget as HTMLElement;
      setDragIndex(index);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
      requestAnimationFrame(() => {
        if (dragNode.current) {
          dragNode.current.classList.add('opacity-40');
        }
      });
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>, index: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (index !== overIndex) {
        setOverIndex(index);
      }
    },
    [overIndex],
  );

  const handleDragEnd = useCallback(() => {
    if (dragNode.current) {
      dragNode.current.classList.remove('opacity-40');
    }
    dragNode.current = null;

    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      const newItems = [...items];
      const [removed] = newItems.splice(dragIndex, 1);
      newItems.splice(overIndex, 0, removed);
      onReorder(newItems);
    }

    setDragIndex(null);
    setOverIndex(null);
  }, [dragIndex, overIndex, items, onReorder]);

  const handleDragLeave = useCallback(() => {
    setOverIndex(null);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className={className} onDragLeave={handleDragLeave}>
      {items.map((item, index) => {
        const isDragging = dragIndex === index;
        const showDropBefore = overIndex === index && dragIndex !== null && dragIndex !== index;
        const showDropAfter =
          overIndex === index && dragIndex !== null && dragIndex > index;

        return (
          <div key={getKey(item, index)}>
            {/* 上方插入指示线 */}
            {showDropBefore && (
              <div className="h-0.5 bg-emerald-500 rounded-full mx-2 transition-all" />
            )}

            {showHandle ? (
              /* 列表模式：拖拽手柄 + 内容 */
              <div
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragEnd={handleDragEnd}
                className="group/item relative flex items-start gap-1"
              >
                <div className="flex-shrink-0 pt-3 pl-1 cursor-grab active:cursor-grabbing opacity-40 group-hover/item:opacity-100 transition-opacity">
                  <GripVertical className="w-4 h-4 text-gray-400" />
                </div>
                <div className="flex-1 min-w-0">{renderItem(item, index, isDragging)}</div>
              </div>
            ) : (
              /* Grid 模式：整卡可拖拽 */
              <div
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragEnd={handleDragEnd}
              >
                {renderItem(item, index, isDragging)}
              </div>
            )}

            {/* 下方插入指示线 */}
            {showDropAfter && (
              <div className="h-0.5 bg-emerald-500 rounded-full mx-2 transition-all" />
            )}
          </div>
        );
      })}
    </div>
  );
}
