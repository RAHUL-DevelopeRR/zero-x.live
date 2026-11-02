// Z.ai (GLM) through its OpenAI-compatible Chat Completions API (docs.z.ai), for the free
// GLM-4.7-Flash and GLM-4.5-Flash pools (key slot zai.free, GLM_API_KEY). Requests go out as for
// every OpenAI-compatible upstream (src/provider-adapter.js: api.z.ai only, redirect 'manual');
// providers.js shapes the body (buildUpstreamPayload: tool_choice "auto" only, thinking off for
// reasoning_effort "none") and turns Z.ai's error finish_reasons and business codes into failed
// attempts (ERROR_FINISH_REASONS, classifyUpstreamFailure).
import { OpenAICompatibleAdapter } from './provider-adapter.js';
import { catalogEntries } from './catalog.js';
import { PROVIDER_TYPES } from './catalog-types.js';

export class ZaiAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({
      id: 'zai',
      keyVar: 'GLM_API_KEY',
      modelsVar: 'ZAI_MODELS',
      defaultBase: PROVIDER_TYPES.zai.base_url,
      providerPrefix: true,
    });
  }

  catalogSource() {
    return 'allowlist';
  }

  listStaticModels(env, session = {}) {
    if (!this.isConfigured(env, session)) return [];
    return catalogEntries(env).filter(entry => entry.provider === this.id);
  }

  // No network call: the models are the catalog's Z.ai rows, and the free models serve one
  // request at a time per account, so operator health never spends a call on them.
  async discoverModels(env, session = {}) {
    const configured = this.isConfigured(env, session);
    return { provider: this.id, status: configured ? 'configured' : 'not_configured', discovery: false,
      models: configured ? this.listStaticModels(env, session) : [] };
  }
}
