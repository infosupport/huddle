// Workspace-flow type-scaffolding.
//
// Definieert de entiteiten van de end-to-end keten Ticket → Project →
// Repository → Devcontainer → IDE (feature 08). Dit is voorbereidend werk:
// hier staan alleen de contracten, nog geen implementatie.
//
// De workflow-entry-points sluiten aan op de extensie-architectuur (feature
// 03): een extensie levert de ingang van de workflow en vertaalt de context
// van een extern ticketsysteem naar een afgeschermde Huddle-workspace. De
// `extensionId` verwijst naar de `id` van een `HuddleExtension`
// (gateway/src/extensions/types.ts — nog te bouwen in feature 03).

import type { IdeName } from '../docker';

/**
 * Een ticket uit een extern systeem (Freshdesk, Jira, …), opgehaald door een
 * extensie. Het ticket levert de werkcontext waarmee Huddle een workspace
 * opbouwt. Het `source`-veld koppelt het ticket aan de extensie die het
 * heeft aangeleverd.
 */
export interface WorkflowTicket {
  /** Stabiele id binnen het bronsysteem, bv. een Freshdesk-ticketnummer. */
  id: string;
  /** Id van de extensie die dit ticket heeft aangeleverd (zie feature 03). */
  source: string;
  title: string;
  description?: string;
  /** Vrije sleutel-waarde-context uit het bronsysteem (klant, prioriteit, …). */
  metadata?: Record<string, string>;
  /**
   * Optionele hint naar een project of repository die het bronsysteem al
   * koppelt aan dit ticket. Een extensie kan dit gebruiken om stap 2
   * (projectselectie) over te slaan of voor te stellen.
   */
  projectHint?: string;
}

/**
 * Een project mapt op een set repositories, een voorkeur-IDE en een
 * devcontainer-image. Projecten zijn data-gedreven (configuratie), niet
 * hardgecodeerd per bronsysteem.
 */
export interface WorkflowProject {
  id: string;
  name: string;
  /** Repositories die bij dit project horen (stap 3). */
  repositories: WorkflowRepository[];
  /** Voorkeur-IDE; default-keuze voor de omgeving. */
  defaultIde?: IdeName;
  /** Voorkeurs-image of -snapshot voor de devcontainer (stap 4). */
  defaultImage?: string;
}

/**
 * Een repository die lokaal als werkmap beschikbaar moet zijn in de
 * devcontainer. `workspaceDir` sluit aan op de bestaande `StartParams`
 * (gateway/src/docker.ts): het host-pad dat als /workspaces/<leaf> wordt
 * gemount. `subPath` is voorbereidend werk voor padgebaseerde
 * firewall-scoping (feature 01).
 */
export interface WorkflowRepository {
  id: string;
  name: string;
  /** Host-pad van de werkmap (forward slashes), zoals StartParams.workspaceDir. */
  workspaceDir: string;
  /** Optioneel subpad binnen de repo voor fijnmazige firewall-scoping (feature 01). */
  subPath?: string;
}

/**
 * De concrete devcontainer/IDE-combinatie die uit een project + ticket wordt
 * afgeleid. Vertaalt rechtstreeks naar `StartParams` van
 * createAndStartContainer (gateway/src/docker.ts).
 */
export interface WorkflowEnvironment {
  /** Image of snapshot die gestart wordt (StartParams.imageName). */
  imageName: string;
  ideName: IdeName;
  /** De repository die als werkmap wordt gemount. */
  repository: WorkflowRepository;
}

/** Levenscyclus-fasen van een workspace-sessie. */
export type WorkflowSessionStatus =
  | 'pending'    // sessie aangemaakt, container nog niet gestart
  | 'starting'   // container wordt aangemaakt/gestart
  | 'running'    // container draait, IDE benaderbaar
  | 'stopped'    // container gestopt
  | 'failed';    // start of een latere stap is mislukt

/**
 * Een actieve (of historische) workspace-sessie: het resultaat van een
 * doorlopen workflow. Koppelt het oorspronkelijke ticket aan de gestarte
 * container, zodat de keten herleidbaar blijft.
 */
export interface WorkflowSession {
  id: string;
  /** Extensie die de workflow heeft gestart (zie WorkflowEntryPoint.extensionId). */
  extensionId: string;
  ticket: WorkflowTicket;
  project?: WorkflowProject;
  environment?: WorkflowEnvironment;
  /** Naam van de gestarte container (StartParams.containerName), indien gestart. */
  containerName?: string;
  status: WorkflowSessionStatus;
  createdAt: string;
  /** Foutmelding wanneer status 'failed' is. */
  error?: string;
}

/**
 * De extensie-hook voor workflow-entry. Een extensie (feature 03) implementeert
 * dit om de ingang van de workflow te vormen: gegeven een ticket levert
 * `start` een workspace-sessie op. De kern van Huddle kent de extensie niet bij
 * naam; ze wordt via de registry aangemeld.
 */
export interface WorkflowEntryPoint {
  /** Verwijst naar de id van een HuddleExtension (feature 03). */
  extensionId: string;
  /** Weergavenaam in de UI, bv. "Start vanuit Freshdesk". */
  label: string;
  /** Start een workflow vanuit een ticket en levert de resulterende sessie. */
  start(ticket: WorkflowTicket): Promise<WorkflowSession>;
}

/**
 * Registry voor workflow-entry-points. Eén centrale plek waar extensies hun
 * workflow-ingang aanmelden; de core itereert erover i.p.v. elke extensie hard
 * te kennen (zelfde registry-patroon als feature 03).
 */
export interface WorkflowRegistry {
  /** Meld een entry-point aan. */
  register(entryPoint: WorkflowEntryPoint): void;
  /** Alle aangemelde entry-points. */
  list(): WorkflowEntryPoint[];
  /** Zoek een entry-point op de extensie-id. */
  get(extensionId: string): WorkflowEntryPoint | undefined;
}
