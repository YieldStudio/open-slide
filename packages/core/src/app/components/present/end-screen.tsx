import { usePanelMount } from '@/components/panel/panel-shell';
import { useLocale } from '@/lib/use-locale';
import { cn } from '@/lib/utils';

type Props = {
  open: boolean;
  onExit: () => void;
};

export function PresentEndScreen({ open, onExit }: Props) {
  const t = useLocale();
  const { mounted, animVisible } = usePanelMount(open);
  if (!mounted) return null;
  return (
    <button
      type="button"
      onClick={onExit}
      className={cn(
        'absolute inset-0 z-20 flex cursor-[inherit] flex-col items-center justify-center gap-2 bg-black text-white outline-none motion-safe:transition-opacity',
        animVisible ? 'opacity-100 motion-safe:duration-200' : 'opacity-0 motion-safe:duration-150',
      )}
    >
      <span className="font-heading text-[15px] font-medium tracking-[-0.01em] text-white/80">
        {t.present.endOfShow}
      </span>
      <span className="text-[12px] text-white/45">{t.present.endOfShowHint}</span>
    </button>
  );
}
