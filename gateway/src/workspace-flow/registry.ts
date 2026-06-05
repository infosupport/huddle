// Skelet-implementatie van de WorkflowRegistry (feature 08).
//
// Houdt workflow-entry-points bij, geïndexeerd op extensie-id. Nog geen
// koppeling met de extensie-architectuur (feature 03) of met
// createAndStartContainer (gateway/src/docker.ts) — dit is voorbereidend werk.

import type { WorkflowEntryPoint, WorkflowRegistry } from './types';

export class InMemoryWorkflowRegistry implements WorkflowRegistry {
  private readonly entryPoints = new Map<string, WorkflowEntryPoint>();

  register(entryPoint: WorkflowEntryPoint): void {
    if (this.entryPoints.has(entryPoint.extensionId)) {
      throw new Error(
        `workflow-entry-point voor extensie "${entryPoint.extensionId}" is al geregistreerd`,
      );
    }
    this.entryPoints.set(entryPoint.extensionId, entryPoint);
  }

  list(): WorkflowEntryPoint[] {
    return [...this.entryPoints.values()];
  }

  get(extensionId: string): WorkflowEntryPoint | undefined {
    return this.entryPoints.get(extensionId);
  }
}

/** Gedeelde registry-instantie voor de workspace-flow. */
export const workflowRegistry: WorkflowRegistry = new InMemoryWorkflowRegistry();
