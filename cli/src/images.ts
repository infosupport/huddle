import { activeExperiment, imageTag } from './config';
import { localImageName } from './base-images';

/**
 * Channel-aware image resolution: based on the active channel (stable or
 * experiment), determines which gateway image init pulls and which locally
 * built base images the gateway uses.
 * That keeps init.ts pure orchestration of runtime and containers.
 */

export interface BaseImage {
  image: string;
  /** Env var by which the gateway picks this image for devcontainers. */
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
    // Built locally (see base-images.ts), never pulled. BASE_IMAGE_<IDE> still
    // overrides, e.g. to point at a self-built or team-registry image.
    baseImages: [
      { image: process.env.BASE_IMAGE ?? localImageName(undefined, tag), gatewayEnv: 'BASE_IMAGE' },
      { image: process.env.BASE_IMAGE_RIDER ?? localImageName('rider', tag), gatewayEnv: 'BASE_IMAGE_RIDER' },
      { image: process.env.BASE_IMAGE_INTELLIJ ?? localImageName('intellij', tag), gatewayEnv: 'BASE_IMAGE_INTELLIJ' },
      { image: process.env.BASE_IMAGE_WEBSTORM ?? localImageName('webstorm', tag), gatewayEnv: 'BASE_IMAGE_WEBSTORM' },
      { image: process.env.BASE_IMAGE_VSCODE ?? localImageName('vscode', tag), gatewayEnv: 'BASE_IMAGE_VSCODE' },
    ],
  };
}

/**
 * `-e KEY=val` argv pairs for the gateway container, so it starts devcontainers
 * from (and, if missing, builds) exactly the local images of the active channel.
 * Returned as an argv array (not a shell string) so init can spawn `docker run`
 * without a shell.
 */
export function gatewayEnvArgs(resolved: ResolvedImages): string[] {
  const args: string[] = [];
  for (const b of resolved.baseImages) {
    if (b.gatewayEnv) args.push('-e', `${b.gatewayEnv}=${b.image}`);
  }
  return args;
}
