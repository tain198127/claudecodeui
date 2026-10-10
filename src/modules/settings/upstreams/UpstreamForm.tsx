import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';
import type { Upstream, UpstreamModel, UpstreamPayload } from '@/shared/types';

type UpstreamFormProps = {
  /** The upstream being edited, or null when creating a new one. */
  upstream: Upstream | null;
  isSaving: boolean;
  onSubmit: (payload: UpstreamPayload) => void;
  onCancel: () => void;
};

const EMPTY_MODEL: UpstreamModel = { id: '', label: '' };

/**
 * Builds the form's initial model rows.
 *
 * A new upstream starts with one blank row so there is always somewhere to type;
 * an existing one gets a trailing blank row so a model can be appended without
 * first pressing "add model".
 */
const toFormModels = (upstream: Upstream | null): UpstreamModel[] => (
  upstream && upstream.models.length > 0
    ? [...upstream.models.map((model) => ({ ...model })), { ...EMPTY_MODEL }]
    : [{ ...EMPTY_MODEL }]
);

/** Used by the settings module's upstreams section to create and edit one endpoint. */
export default function UpstreamForm({ upstream, isSaving, onSubmit, onCancel }: UpstreamFormProps) {
  const { t } = useTranslation('settings');
  const isEditing = upstream !== null;

  const [id, setId] = useState(upstream?.id ?? '');
  const [name, setName] = useState(upstream?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(upstream?.baseUrl ?? '');
  // Always empty on open: the stored token is never sent to the client, so
  // there is nothing to prefill. Empty on submit means "keep the stored one".
  const [authToken, setAuthToken] = useState('');
  const [models, setModels] = useState<UpstreamModel[]>(() => toFormModels(upstream));

  const updateModel = (index: number, patch: Partial<UpstreamModel>) => {
    setModels((previous) => previous.map((model, position) => (
      position === index ? { ...model, ...patch } : model
    )));
  };

  const removeModel = (index: number) => {
    setModels((previous) => previous.filter((_, position) => position !== index));
  };

  const handleSubmit = () => {
    // Blank rows are how the form keeps an empty slot open; they are not models.
    const submittedModels = models
      .filter((model) => model.id.trim())
      .map((model) => ({
        id: model.id.trim(),
        label: model.label.trim() || model.id.trim(),
        ...(model.description?.trim() ? { description: model.description.trim() } : {}),
      }));

    onSubmit({
      id: id.trim(),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      authToken,
      models: submittedModels,
    });
  };

  return (
    <form
      className="space-y-4 rounded-xl border border-border bg-card/50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="upstream-id" className="mb-2 block text-sm font-medium text-foreground">
            {t('upstreams.form.id')}
          </label>
          <Input
            id="upstream-id"
            value={id}
            onChange={(event) => setId(event.target.value)}
            // The id keys the row and reaches the session binding, so renaming
            // an existing upstream would orphan every session pointing at it.
            disabled={isEditing}
            placeholder="deepseek"
            autoComplete="off"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('upstreams.form.idHelp')}</p>
        </div>

        <div>
          <label htmlFor="upstream-name" className="mb-2 block text-sm font-medium text-foreground">
            {t('upstreams.form.name')}
          </label>
          <Input
            id="upstream-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="DeepSeek"
            autoComplete="off"
          />
        </div>
      </div>

      <div>
        <label htmlFor="upstream-base-url" className="mb-2 block text-sm font-medium text-foreground">
          {t('upstreams.form.baseUrl')}
        </label>
        <Input
          id="upstream-base-url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.deepseek.com/anthropic"
          autoComplete="off"
        />
      </div>

      <div>
        <label htmlFor="upstream-token" className="mb-2 block text-sm font-medium text-foreground">
          {t('upstreams.form.authToken')}
        </label>
        <Input
          id="upstream-token"
          type="password"
          value={authToken}
          onChange={(event) => setAuthToken(event.target.value)}
          placeholder={isEditing ? t('upstreams.form.authTokenKeep') : 'sk-...'}
          autoComplete="new-password"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('upstreams.form.authTokenHelp')}</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">{t('upstreams.form.models')}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setModels((previous) => [...previous, { ...EMPTY_MODEL }])}
          >
            <Plus className="h-4 w-4" />
            {t('upstreams.form.addModel')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('upstreams.form.modelsHelp')}</p>

        <div className="space-y-2">
          {models.map((model, index) => (
            <div key={index} className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={model.id}
                onChange={(event) => updateModel(index, { id: event.target.value })}
                placeholder={t('upstreams.form.modelId')}
                aria-label={t('upstreams.form.modelId')}
                autoComplete="off"
                className="sm:flex-[2]"
              />
              <Input
                value={model.label}
                onChange={(event) => updateModel(index, { label: event.target.value })}
                placeholder={t('upstreams.form.modelLabel')}
                aria-label={t('upstreams.form.modelLabel')}
                autoComplete="off"
                className="sm:flex-[2]"
              />
              <Input
                value={model.description ?? ''}
                onChange={(event) => updateModel(index, { description: event.target.value })}
                placeholder={t('upstreams.form.modelDescription')}
                aria-label={t('upstreams.form.modelDescription')}
                autoComplete="off"
                className="sm:flex-[3]"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeModel(index)}
                aria-label={t('upstreams.form.removeModel')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isSaving}>
          {isEditing ? t('upstreams.form.save') : t('upstreams.form.create')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
          {t('upstreams.form.cancel')}
        </Button>
      </div>
    </form>
  );
}
