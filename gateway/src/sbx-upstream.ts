// The sbx egress endpoint, on its own so both halves can name it.
//
// sbx cannot be pointed at the per-container proxy topology, so Huddle opens a
// dedicated listener for it. The GATEWAY serves that port; NODE tells sbx to use
// it when starting a sandbox. Keeping the two constants here means the gateway
// does not have to import the sbx facade — which drags in the execFile
// passthrough, the reconciler and the registry — just to know a port number.

import { runtimeEnv } from './runtime-env';

export const SBX_PROXY_PORT = runtimeEnv.sbxProxyPort;

/** Host part of the URL handed to sbx. sbx dials it from the host, hence localhost. */
const SBX_PROXY_HOST = process.env.HUDDLE_SBX_PROXY_HOST ?? 'localhost';

/** The URL Huddle hands to sbx as its upstream proxy (reached on the host). */
export function sbxUpstreamUrl(): string {
  return `http://${SBX_PROXY_HOST}:${SBX_PROXY_PORT}`;
}
