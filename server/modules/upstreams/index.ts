export { upstreamsService } from '@/modules/upstreams/service.js';

// upstreamResolver: used by the Providers module's runtime context, model
// catalog and auth check to resolve the endpoint a session runs against, and by
// the Upstreams tests that pin the precedence rule.
export { upstreamResolver } from '@/modules/upstreams/resolve.js';
