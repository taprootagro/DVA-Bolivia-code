import type { ReactNode } from "react";
import SortableList, { type SortableItem } from "../SortableList";

type CmsListEditorProps<T extends SortableItem> = {
  items: T[];
  onReorder: (items: T[]) => void;
  renderItem: (item: T, index: number, isDragging: boolean) => ReactNode;
  itemKey?: (item: T, index: number) => string;
};

/** Shared sortable card grid for banners / live / articles (and similar lists). */
export function CmsListEditor<T extends SortableItem>({
  items,
  onReorder,
  renderItem,
  itemKey,
}: CmsListEditorProps<T>) {
  return (
    <SortableList
      items={items}
      onReorder={onReorder}
      itemKey={itemKey}
      showHandle={false}
      className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3"
      renderItem={renderItem}
    />
  );
}
