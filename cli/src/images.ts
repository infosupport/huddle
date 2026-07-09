import { activeExperiment, imageTag } from './config';

/**
 * Kanaal-bewuste image-resolutie: bepaalt op basis van het actieve kanaal
 * (stable of experiment) welke gateway- en base-images init moet gebruiken.
 * init.ts blijft daardoor puur orkestratie van runtime en containers.
 */

export interface BaseImage {
  image: string;
  /** Env-var waarmee de gateway deze image kiest voor devcontainers. */
  gatewayEnv?: string;
}

export interface ResolvedImages {
  /** Actief experiment-nummer, of undefined op stable. */
  experiment?: number;
  /** Image-tag die bij het kanaal hoort (`latest` of `experiment-<nr>`). */
  tag: string;
  /** Gateway-image. Overschrijfbaar via HUDDLE_IMAGE (zet dan ook HUDDLE_NO_PULL=1 voor een lokale build). */
  image: string;
  /**
   * Devcontainer-base-images die de gateway gebruikt om workspaces te starten.
   * De namen komen overeen met getBaseImageName() in de gateway; een override
   * kan via BASE_IMAGE_<IDE>.
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
 * `-e`-flags voor de gateway-container. Tijdens een experiment (of bij een
 * expliciete override) moet de gateway devcontainers starten van dezelfde
 * base-images als de CLI zojuist gepulld heeft.
 */
export function gatewayEnvFlags(resolved: ResolvedImages): string {
  return resolved.baseImages
    .filter((b) => b.gatewayEnv && (resolved.experiment !== undefined || process.env[b.gatewayEnv]))
    .map((b) => ` -e ${b.gatewayEnv}=${b.image}`)
    .join('');
}
