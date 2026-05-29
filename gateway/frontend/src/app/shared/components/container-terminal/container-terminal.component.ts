import { Component, ElementRef, Input, OnDestroy, ViewChild, AfterViewInit } from '@angular/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// Embedded terminal die via WebSocket aan /ws/exec/<container> hangt en de
// container-side pty doorpipet naar xterm.js in de browser.
//
// Het component mount xterm pas in AfterViewInit; instantieer 'm dus lazy
// (alleen wanneer de Terminal-tab actief is) zodat we geen onnodige WS-
// verbinding openen wanneer de gebruiker op een andere tab werkt.

@Component({
  selector: 'app-container-terminal',
  standalone: true,
  templateUrl: './container-terminal.component.html',
  styleUrls: ['./container-terminal.component.css'],
})
export class ContainerTerminalComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) container!: string;

  @ViewChild('host', { static: true }) hostRef!: ElementRef<HTMLDivElement>;

  status = 'Verbinden...';
  private term?: Terminal;
  private fit?: FitAddon;
  private ws?: WebSocket;
  private resizeObserver?: ResizeObserver;

  ngAfterViewInit(): void {
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", "Consolas", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: '#0f1117',
        foreground: '#d8dee9',
        cursor: '#88c0d0',
      },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.hostRef.nativeElement);
    this.fit.fit();

    this.connect();

    this.resizeObserver = new ResizeObserver(() => {
      try {
        this.fit?.fit();
        this.sendResize();
      } catch {}
    });
    this.resizeObserver.observe(this.hostRef.nativeElement);
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/exec/${encodeURIComponent(this.container)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.status = 'Verbonden';
      this.sendResize();
      this.term?.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
    });
    ws.addEventListener('message', (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.term?.write(new Uint8Array(ev.data));
      } else if (typeof ev.data === 'string') {
        this.term?.write(ev.data);
      }
    });
    ws.addEventListener('close', (ev) => {
      this.status = `Verbinding gesloten (${ev.code})`;
    });
    ws.addEventListener('error', () => {
      this.status = 'Verbindingsfout';
    });
  }

  private sendResize(): void {
    if (!this.term || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cols = this.term.cols;
    const rows = this.term.rows;
    this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  reconnect(): void {
    try { this.ws?.close(); } catch {}
    this.status = 'Verbinden...';
    this.connect();
  }

  ngOnDestroy(): void {
    try { this.resizeObserver?.disconnect(); } catch {}
    try { this.ws?.close(); } catch {}
    try { this.term?.dispose(); } catch {}
  }
}
