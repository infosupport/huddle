import { activeExperiment, imageTag } from './config';

/**
 * Channel-aware image resolution: based on the active channel (stable or
 * experiment), determines which gateway and base images init should use.
 * That keeps init.ts pure orchestration of runtime and containers.
 */

export interface BaseImage {
  image: string;
  /** Env var by which Huddle Node picks this image for devcontainers. */
  gatewayEnv?: string;
}

export interface ResolvedImages {
  /** Active experiment number, or undefined on stable. */
  experiment?: number;
  /** Image tag that belongs to the channel (`latest` or `experiment-<nr>`). */
  tag: string;
  /** Gateway image. Overridable via HUDDLE_IMAGE (then also set HUDDLE_NO_PULL=1 for a local build). */
  image: string;
  /**
   * Devcontainer base images the gateway uses to start workspaces.
   * The names match getBaseImageName() in the gateway; an override is
   * possible via BASE_IMAGE_<IDE>.
   */
  baseImages: BaseImage[];
}

export function resolveImages(): ResolvedImages {
  const experiment = activeExperiment();
  const tag = imageTag();
  return {
    experiment,
    tag,
    image: process.env.HUDDLE_IMAGE ?? `ghcr.io/infosupport/huddle:${tag}`,
    baseImages: [
      { image: process.env.BASE_IMAGE ?? `ghcr.io/infosupport/base-devimage:${tag}` },
      { image: process.env.BASE_IMAGE_RIDER ?? `ghcr.io/infosupport/base-devimage-rider:${tag}`, gatewayEnv: 'BASE_IMAGE_RIDER' },
      { image: process.env.BASE_IMAGE_INTELLIJ ?? `ghcr.io/infosupport/base-devimage-intellij:${tag}`, gatewayEnv: 'BASE_IMAGE_INTELLIJ' },
      { image: process.env.BASE_IMAGE_VSCODE ?? `ghcr.io/infosupport/base-devimage-vscode:${tag}`, gatewayEnv: 'BASE_IMAGE_VSCODE' },
    ],
  };
}

/**
 * Base-image overrides for HUDDLE NODE's environment. During an experiment (or
 * with an explicit override) Huddle Node must start devcontainers from the same
 * base images the CLI just pulled.
 *
 * These went to the gateway container as `-e` pairs until Docker orchestration
 * moved to the host (docs/ADR-huddle-node-split.md). The gateway does not create
 * containers any more, so it has no use for them — and giving the network-facing
 * half env vars it does not read is how stale coupling survives a split.
 */
export function baseImageEnv(resolved: ResolvedImages): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const b of resolved.baseImages) {
    if (b.gatewayEnv && (resolved.experiment !== undefined || process.env[b.gatewayEnv])) {
      env[b.gatewayEnv] = b.image;
    }
  }
  return env;
}
