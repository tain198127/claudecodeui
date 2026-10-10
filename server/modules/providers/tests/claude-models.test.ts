import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  ClaudeProviderModels,
  extractClaudeEventModel,
} from '@/modules/providers/list/claude/claude-models.provider.js';
import { upstreamsService } from '@/modules/upstreams/index.js';

const SESSION_ID = 'session-1';

/**
 * Runs a test against a throwaway database.
 *
 * The catalog reads the install's default upstream, so proving the built-in
 * list is still returned requires a database that genuinely has no upstream
 * configured rather than a stub that pretends so.
 */
async function withTempDatabase(runTest: () => Promise<void> | void): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-models-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('with no upstream configured the built-in catalog is returned unchanged', async () => {
  await withTempDatabase(async () => {
    const models = await new ClaudeProviderModels().getSupportedModels();

    // Identity, not deep equality: the requirement is that an unconfigured
    // install gets exactly the built-in definition back, untouched.
    assert.equal(models, CLAUDE_PREDEFINED_MODELS);
    assert.equal(models.OPTIONS.length, 9);
    assert.deepEqual(
      models.OPTIONS.map((option) => option.value),
      ['default', 'best', 'fable', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'haiku', 'opusplan'],
    );
    assert.equal(models.DEFAULT, 'default');
  });
});

test('the default upstream replaces the catalog with its own models', async () => {
  await withTempDatabase(async () => {
    upstreamsService.create({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      authToken: 'sk-test',
      models: [
        { id: 'deepseek-chat', label: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', description: 'Slower, thinks first.' },
      ],
      isDefault: true,
    });

    const models = await new ClaudeProviderModels().getSupportedModels();

    // The built-in names are gone: the endpoint has never heard of them.
    assert.deepEqual(models, {
      OPTIONS: [
        { value: 'deepseek-chat', label: 'DeepSeek Chat' },
        { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner', description: 'Slower, thinks first.' },
      ],
      DEFAULT: 'deepseek-chat',
    });
  });
});

test('a default upstream with no models of its own keeps the built-in catalog', async () => {
  await withTempDatabase(async () => {
    upstreamsService.create({
      id: 'empty',
      name: 'Empty',
      baseUrl: 'https://empty.example.com/anthropic',
      authToken: 'sk-test',
      models: [],
      isDefault: true,
    });

    // An empty catalog would leave the model picker with nothing to offer, which
    // is worse than offering the built-in names.
    assert.equal(await new ClaudeProviderModels().getSupportedModels(), CLAUDE_PREDEFINED_MODELS);
  });
});

test('an upstream that is not the default leaves the built-in catalog alone', async () => {
  await withTempDatabase(async () => {
    upstreamsService.create({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      authToken: 'sk-test',
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
    });

    // Creating one does not make it the default, so nothing resolves yet.
    assert.equal(await new ClaudeProviderModels().getSupportedModels(), CLAUDE_PREDEFINED_MODELS);
  });
});
