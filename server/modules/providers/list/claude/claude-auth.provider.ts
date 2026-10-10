import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

// upstreamResolver: used to report a configured endpoint as the install's
// credential source, matching what the runtime actually authenticates with.
import { upstreamResolver } from '@/modules/upstreams/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/** Credential stores Claude Code consults, in the order `checkCredentials` tries them. */
type ClaudeCredentialsSource = 'upstream' | 'environment' | 'settings' | 'credentials_file';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  /**
   * Which credential store answered. `upstream` means a configured endpoint
   * supplied both the URL and the token, which is what Settings reports so an
   * operator can tell "signed in with Claude" from "pointed at a gateway".
   * Absent when nothing authenticated the install.
   */
  source?: ClaudeCredentialsSource;
  error?: string;
};

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

export class ClaudeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Claude Code CLI is available on this host.
   */
  private checkInstalled(): boolean {
    // cross-spawn resolves shims and PATHEXT itself, so the bare command is a
    // usable fallback here even where the SDK's raw spawn could not use it.
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
    try {
      spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth priority.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'claude',
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      credentialSource: credentials.source,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   */
  /**
   * Reads the install's default upstream, treating an unreadable store as "none".
   *
   * This is a status probe: it is polled from Settings and its whole contract is
   * to report what it can find. A store it only consults in order to *describe*
   * the credential state must not be able to fail the probe, so a read error
   * degrades to the environment checks below — which is exactly what an install
   * with no upstreams does anyway.
   */
  private readDefaultUpstream() {
    try {
      return upstreamResolver.resolveDefault();
    } catch {
      return null;
    }
  }

  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

    // Checked before the environment because the runtime injects an upstream's
    // base URL and token *over* the host environment, so a configured endpoint
    // is what a run actually authenticates with. An upstream whose stored token
    // cannot be decrypted is not usable and falls through to the checks below.
    const upstream = this.readDefaultUpstream();
    if (upstream?.authToken) {
      return {
        authenticated: true,
        email: upstream.upstream.name,
        method: 'api_key',
        source: 'upstream',
      };
    }

    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'Auth Token', method: 'api_key', source: 'environment' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key', source: 'environment' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key', source: 'settings' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return {
        authenticated: true,
        email: 'Configured via settings.json',
        method: 'api_key',
        source: 'settings',
      };
    }

    if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
      return {
        authenticated: true,
        email: 'OAuth Token (long-lived)',
        method: 'environment',
        source: 'environment',
      };
    }

    if (readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
      return {
        authenticated: true,
        email: 'OAuth Token (long-lived)',
        method: 'environment',
        source: 'settings',
      };
    }

    try {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
            source: 'credentials_file',
          };
        }

        // `accessToken` is short-lived (hours). Claude Code renews it silently
        // from `refreshToken` on the next CLI invocation, so an expired access
        // token alongside a live refresh token is still a working login. Before
        // this check, a still-signed-in account read as "login has expired"
        // until something else happened to run the CLI — which is why opening
        // the Shell tab and coming back made Settings flip to Connected.
        const refreshToken = readOptionalString(oauth?.refreshToken);
        const refreshTokenExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
          ? oauth.refreshTokenExpiresAt
          : undefined;
        if (refreshToken && (!refreshTokenExpiresAt || Date.now() < refreshTokenExpiresAt)) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
            source: 'credentials_file',
          };
        }

        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Claude login has expired. Run claude /login again.',
        };
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      };
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }
}
