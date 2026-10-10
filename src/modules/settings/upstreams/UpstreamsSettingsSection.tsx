import { Check, Pencil, Plus, Star, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';
import UpstreamForm from '@/modules/settings/upstreams/UpstreamForm';
import { useUpstreamsSettings } from '@/modules/settings/hooks/useUpstreamsSettings';
import { Badge, Button } from '@/shared/ui';
import type { Upstream, UpstreamPayload } from '@/shared/types';

/** Used by Settings for the "upstreams" tab, listing the configured Anthropic-compatible endpoints. */
export default function UpstreamsSettingsSection() {
  const { t } = useTranslation('settings');
  const {
    upstreams,
    isLoading,
    error,
    pendingId,
    testResults,
    create,
    update,
    remove,
    setDefault,
    test,
  } = useUpstreamsSettings();

  // Which form is open: 'new', an upstream id being edited, or null for neither.
  // Only one form is ever shown, so a single value is enough.
  const [openForm, setOpenForm] = useState<'new' | string | null>(null);

  const handleSubmit = async (payload: UpstreamPayload) => {
    const saved = openForm === 'new'
      ? await create(payload)
      : await update(payload.id, payload);

    if (saved) {
      setOpenForm(null);
    }
  };

  const renderTestResult = (upstream: Upstream) => {
    const result = testResults[upstream.id];
    if (!result) {
      return null;
    }

    if (result.ok) {
      const modelIds = result.modelIds ?? [];
      return (
        <p className="text-xs text-muted-foreground">
          {modelIds.length > 0
            ? t('upstreams.test.models', { count: modelIds.length, models: modelIds.join(', ') })
            : t('upstreams.test.noModels')}
        </p>
      );
    }

    return (
      <p className="text-xs text-destructive">
        {result.error ?? t('upstreams.test.failed')}
      </p>
    );
  };

  return (
    <SettingsSection
      title={t('upstreams.title')}
      description={t('upstreams.description')}
    >
      <div className="space-y-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground">{t('upstreams.loading')}</p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {!isLoading && upstreams.length === 0 && openForm === null && (
          <SettingsCard className="p-4">
            <p className="text-sm text-muted-foreground">{t('upstreams.empty')}</p>
          </SettingsCard>
        )}

        {upstreams.map((upstream) => (
          <SettingsCard key={upstream.id} className="p-4">
            {openForm === upstream.id ? (
              <UpstreamForm
                upstream={upstream}
                isSaving={pendingId === upstream.id}
                onSubmit={handleSubmit}
                onCancel={() => setOpenForm(null)}
              />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{upstream.name}</span>
                      {upstream.isDefault && (
                        <Badge variant="secondary">{t('upstreams.defaultBadge')}</Badge>
                      )}
                      {!upstream.hasToken && (
                        <Badge variant="destructive">{t('upstreams.noTokenBadge')}</Badge>
                      )}
                    </div>
                    <p className="mt-1 break-all text-xs text-muted-foreground">{upstream.baseUrl}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('upstreams.modelCount', { count: upstream.models.length })}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pendingId === upstream.id}
                      onClick={() => void test(upstream.id)}
                    >
                      <Zap className="h-4 w-4" />
                      {t('upstreams.test.action')}
                    </Button>
                    {!upstream.isDefault && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pendingId === upstream.id}
                        onClick={() => void setDefault(upstream.id)}
                      >
                        <Star className="h-4 w-4" />
                        {t('upstreams.setDefault')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pendingId === upstream.id}
                      onClick={() => setOpenForm(upstream.id)}
                    >
                      <Pencil className="h-4 w-4" />
                      {t('upstreams.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pendingId === upstream.id}
                      onClick={() => void remove(upstream.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('upstreams.remove')}
                    </Button>
                  </div>
                </div>

                {renderTestResult(upstream)}
              </div>
            )}
          </SettingsCard>
        ))}

        {openForm === 'new' ? (
          <UpstreamForm
            upstream={null}
            isSaving={pendingId !== null}
            onSubmit={handleSubmit}
            onCancel={() => setOpenForm(null)}
          />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setOpenForm('new')}>
            <Plus className="h-4 w-4" />
            {t('upstreams.create')}
          </Button>
        )}

        {upstreams.length > 0 && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5" />
            {t('upstreams.footnote')}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
