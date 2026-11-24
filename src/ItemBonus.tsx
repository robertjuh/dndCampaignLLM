import { useId } from 'react';
import type { LucideIcon } from 'lucide-react';

export function ItemBonus({
  label,
  description,
  icon: Icon,
}: {
  label: string;
  description: string;
  icon: LucideIcon;
}) {
  const id = useId();
  return (
    <span className="item-bonus">
      <button
        type="button"
        className="item-bonus-button"
        popoverTarget={id}
        aria-label={label}
        aria-describedby={id}
        onClick={(event) => {
          event.stopPropagation();
          const tooltip = document.getElementById(id)!;
          const bounds = event.currentTarget.getBoundingClientRect();
          const width = Math.min(320, window.innerWidth - 24);
          tooltip.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
          tooltip.style.top = `${bounds.bottom + 238 <= window.innerHeight ? bounds.bottom + 8 : Math.max(12, bounds.top - 238)}px`;
        }}
      >
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
      </button>
      <span id={id} popover="auto" role="tooltip" className="item-bonus-tooltip">
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
    </span>
  );
}
