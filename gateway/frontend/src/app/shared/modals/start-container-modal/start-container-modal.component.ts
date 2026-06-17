import { Component, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalService } from '../../../core/services/modal.service';
import { ApiService } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';
import { DockerImage } from '../../../core/models/container.model';
import { FmtBytesPipe } from '../../pipes/fmt-bytes.pipe';

@Component({
  selector: 'app-start-container-modal',
  standalone: true,
  imports: [FormsModule, FmtBytesPipe],
  templateUrl: './start-container-modal.component.html',
  styles: []
})
export class StartContainerModalComponent {
  modalService = inject(ModalService);
  private api = inject(ApiService);
  private state = inject(StateService);

  images: DockerImage[] = [];
  baseImage = '';
  selectedImage = '';
  ide: 'rider' | 'intellij' | 'vscode' = 'intellij';
  workspace = '';
  containerName = '';
  nameTouched = false;
  empty = false;
  error = '';
  status = '';
  loading = false;
  workspaceSuggestions: string[] = [];

  get open() { return this.modalService.startOpen(); }

  constructor() {
    effect(() => {
      if (this.modalService.startOpen()) {
        this.onOpen();
      }
    });
  }

  onOpen(): void {
    this.selectedImage = '';
    this.ide = 'intellij';
    this.workspace = '';
    this.containerName = '';
    this.nameTouched = false;
    this.empty = false;
    this.error = '';
    this.status = '';
    this.loading = false;
    this.loadImagesForIde();
    this.api.getWorkspaces().subscribe({ next: ws => { this.workspaceSuggestions = ws; }, error: () => {} });
  }

  // De IDE-keuze stuurt zowel de default base-image als het snapshot-filter.
  // Beide endpoints zijn nu IDE-specifiek; deze methode haalt ze opnieuw op.
  onIdeChange(): void {
    this.selectedImage = '';
    this.loadImagesForIde();
  }

  private loadImagesForIde(): void {
    this.api.getImages(this.ide).subscribe({ next: imgs => { this.images = imgs; }, error: () => {} });
    this.api.getBaseImage(this.ide).subscribe({
      next: b => { this.baseImage = b.imageName; if (!this.selectedImage) this.selectedImage = b.imageName; },
      error: () => { this.baseImage = ''; }
    });
  }

  onWorkspaceInput(): void {
    if (!this.nameTouched) {
      const leaf = this.workspace.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
      this.containerName = leaf ? `devcontainer-${leaf}` : '';
    }
  }

  // Opent het Verkenner-venster zodat de gebruiker naar de map kan bladeren.
  // De browser geeft bewust alleen de mapnaam terug, niet het absolute pad
  // (security). Daarom lezen we daarnaast het klembord: heeft de gebruiker het
  // volledige pad uit de adresbalk van Verkenner gekopieerd, dan vullen we dat
  // automatisch in; anders nemen we de mapnaam als beginpunt. Het veld blijft
  // bewerkbaar, dus een verkeerde gok is altijd corrigeerbaar.
  async browseWorkspace(): Promise<void> {
    let folderName = '';
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'read' });
      folderName = handle?.name ?? '';
    } catch {
      return; // gebruiker annuleerde
    }
    let chosen = folderName;
    try {
      const clip = this.normalizePastedPath(await navigator.clipboard.readText());
      const leaf = clip.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      // Gebruik het geplakte pad alleen als het bij de gekozen map hoort, zodat
      // een toevallig oud klembord-pad niet de selectie overschrijft.
      if (clip && (!folderName || leaf === folderName)) {
        chosen = clip;
      }
    } catch {
      // Klembord niet beschikbaar (geen toestemming / onveilige context).
    }
    if (chosen) {
      this.workspace = chosen;
      this.onWorkspaceInput();
    }
  }

  // Windows' "Als pad kopiëren" zet het pad tussen dubbele quotes; strip die.
  private normalizePastedPath(text: string): string {
    return text.trim().replace(/^"+|"+$/g, '').trim();
  }

  onEmptyToggle(): void {
    if (this.empty) {
      this.workspace = '';
      if (!this.nameTouched && !this.containerName) {
        this.containerName = 'devcontainer-empty';
      }
    }
  }

  confirm(): void {
    if (!this.selectedImage || !this.containerName || (!this.empty && !this.workspace)) {
      this.error = 'Alle velden zijn verplicht'; return;
    }
    this.error = '';
    this.loading = true;
    this.status = 'Container wordt gestart…';
    this.api.startContainer({
      image: this.selectedImage,
      ide: this.ide,
      workspace: this.workspace,
      containerName: this.containerName,
      empty: this.empty,
    }).subscribe({
      next: () => {
        this.loading = false; this.modalService.closeStart(); this.state.loadAll();
      },
      error: (err) => { this.error = err.message; this.status = ''; this.loading = false; },
    });
  }

  // Onthoudt of de muisknop op de backdrop zélf ingedrukt werd (buiten de box).
  // Een 'click' vuurt op de gemeenschappelijke voorouder van mousedown + mouseup,
  // dus een selectie die binnen de box start en buiten eindigt zou anders de
  // popup sluiten. Door alleen te sluiten als de druk op de backdrop begon,
  // sluit van-binnen-naar-buiten selecteren de popup niet, maar buiten klikken wel.
  private backdropMouseDown = false;

  onBackdropMouseDown(event: MouseEvent): void {
    this.backdropMouseDown = event.target === event.currentTarget;
  }

  onBackdropClick(event: MouseEvent): void {
    if (this.backdropMouseDown && event.target === event.currentTarget) {
      this.close();
    }
    this.backdropMouseDown = false;
  }

  close(): void { this.modalService.closeStart(); }
}
