import { memo, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';
import type { Upstream } from '@/shared/types';

type ComposerUpstreamMenuProps = {
  /** Configured endpoints; an empty list hides the menu entirely. */
  upstreams: Upstream[];
  /** The upstream the open session follows, or null for the install default. */
  upstreamId: string | null;
  onSelectUpstream: (upstreamId: string | null) => void;
};

/**
 * Rendered by chat's ChatComposer as the popover for choosing which configured
 * endpoint the session's turns are sent to.
 *
 * Offers no control when nothing is configured: an install with no upstreams
 * behaves exactly as it did before the feature existed, so there is nothing
 * meaningful to pick and the trigger is not rendered at all.
 */
function ComposerUpstreamMenu({ upstreams, upstreamId, onSelectUpstream }: ComposerUpstreamMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  const selected = useMemo(
    () => upstreams.find((upstream) => upstream.id === upstreamId) ?? null,
    [upstreamId, upstreams],
  );

  if (upstreams.length === 0) {
    return null;
  }

  const ariaLabel = t('composer.upstreamMenu', { defaultValue: 'Select upstream endpoint' });
  const triggerLabel = selected?.name ?? t('composer.upstreamDefault', { defaultValue: 'Default endpoint' });

  const select = (nextUpstreamId: string | null) => {
    onSelectUpstream(nextUpstreamId);
    setIsOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-20 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-40"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="truncate">{triggerLabel}</span>
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          <ComposerMenuHeading>
            {t('composer.upstream', { defaultValue: 'Upstream endpoint' })}
          </ComposerMenuHeading>

          <ComposerMenuItem
            label={t('composer.upstreamDefaultOption', { defaultValue: 'Follow the default' })}
            isSelected={upstreamId === null}
            onSelect={() => select(null)}
          />
          {upstreams.map((upstream) => (
            <ComposerMenuItem
              key={upstream.id}
              label={upstream.name}
              description={upstream.baseUrl}
              isSelected={upstream.id === upstreamId}
              onSelect={() => select(upstream.id)}
            />
          ))}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerUpstreamMenu);
