// 电视版操作表：居中纵列选项弹窗。
// 三个共用场景：集行长按 OK（播放/标记）、季 chip 长按 OK（整季标已看/重置）、
// 删除影视的二次确认（默认焦点在「取消」——遥控器误触不允许直达删除）。
// OK 选择并关闭，Back/Esc 直接关闭。

import type { ComponentType } from 'react';
import { clsx } from 'clsx';
import { useFocusIndex, useModalGamepad } from '../gamepad';

export interface ActionSheetItem {
  icon: ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

interface Props {
  title: string;
  subtitle?: string;
  items: ActionSheetItem[];
  /** 初始焦点项（默认第 0 项） */
  initialIndex?: number;
  onClose: () => void;
}

export default function ActionSheet({ title, subtitle, items, initialIndex = 0, onClose }: Props) {
  useModalGamepad('modal:action-sheet', {
    onClose,
    count: items.length,
    cols: 1,
    initialIndex,
    activate: (i) => {
      const it = items[i];
      if (!it) return;
      onClose();
      it.onSelect();
    },
  });
  const focused = useFocusIndex('modal:action-sheet');

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-8">
      <div className="absolute inset-0 bg-black/75 animate-fade-in" />
      <div className="relative glass-modal shadow-2xl animate-scale-in px-7 py-6 flex flex-col gap-4 min-w-[400px] max-w-[560px]">
        <div className="flex flex-col gap-1 px-2">
          <h2 className="text-xl font-bold truncate">{title}</h2>
          {subtitle && <p className="text-sm text-text-secondary leading-relaxed">{subtitle}</p>}
        </div>
        <div className="flex flex-col gap-2">
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <button
                key={it.label}
                onClick={() => { onClose(); it.onSelect(); }}
                className={clsx('action-sheet-item', it.danger && 'danger', focused === i && 'gamepad-focus')}
              >
                <Icon size={17} />
                <span className="truncate">{it.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
