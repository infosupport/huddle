import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';

interface Penguin {
  id: number;
  name: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div style="max-width:600px;margin:40px auto;padding:20px">
      <h1 style="text-align:center;margin-bottom:30px;font-size:2.5rem">🐧 Pinguins</h1>

      <div style="background:#fff;border-radius:12px;padding:24px;margin-bottom:24px;color:#333">
        <h2 style="margin-bottom:16px;color:#1a3a5c">Nieuwe pinguin toevoegen</h2>
        <div style="display:flex;gap:12px">
          <input
            [(ngModel)]="newName"
            placeholder="Naam van de pinguin"
            (keyup.enter)="addPenguin()"
            style="flex:1;padding:10px 14px;border:2px solid #1a3a5c;border-radius:8px;font-size:1rem;outline:none"
          />
          <button
            (click)="addPenguin()"
            [disabled]="!newName.trim()"
            style="padding:10px 20px;background:#1a3a5c;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer"
          >Toevoegen</button>
        </div>
      </div>

      <div *ngIf="penguins.length === 0" style="text-align:center;opacity:0.7;padding:40px">
        Nog geen pinguins. Voeg er een toe!
      </div>

      <div *ngFor="let p of penguins" style="background:#fff;border-radius:12px;padding:16px 20px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;color:#333">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-size:2rem">🐧</span>
          <span style="font-size:1.1rem;font-weight:bold">{{p.name}}</span>
        </div>
        <button
          (click)="deletePenguin(p.id)"
          style="padding:8px 16px;background:#e53935;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem"
        >Verwijderen</button>
      </div>
    </div>
  `
})
export class AppComponent implements OnInit {
  penguins: Penguin[] = [];
  newName = '';

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.loadPenguins();
  }

  loadPenguins() {
    this.http.get<Penguin[]>('/api/penguins').subscribe(data => this.penguins = data);
  }

  addPenguin() {
    if (!this.newName.trim()) return;
    this.http.post<Penguin>('/api/penguins', { name: this.newName.trim() }).subscribe(() => {
      this.newName = '';
      this.loadPenguins();
    });
  }

  deletePenguin(id: number) {
    this.http.delete(`/api/penguins/${id}`).subscribe(() => this.loadPenguins());
  }
}
