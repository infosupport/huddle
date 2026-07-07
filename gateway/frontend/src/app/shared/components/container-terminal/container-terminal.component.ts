import { Component, ElementRef, Input, OnDestroy, ViewChild, AfterViewInit } from '@angular/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// Embedded terminal that connects via WebSocket to /ws/terminal/<container>. The
// backend shares a single Docker exec across multiple clients (multi-attach), so two
// tabs on the same container see the same session.
//
// Only mount xterm in AfterViewInit; instantiate this component lazily (only
// when the Terminal tab is active) so we don't open an unnecessary WS connection.

interface DetectedUrl {
  url: string;
  row: number;
}

@Component({
  selector: 'app-container-terminal',
  standalone: true,
  templateUrl: './container-terminal.component.html',
  styleUrls: ['./container-terminal.component.css'],
})
export class ContainerTerminalComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) container!: string;

  @ViewChild('termRef', { static: true }) termRef!: ElementRef<HTMLDivElement>;

  connected = false;
  autoScroll = true;
  detectedUrls: DetectedUrl[] = [];
  hoveredRow: number | null = null;

  quickKeys = [
    { label: 'y', data: 'y' },
    { label: 'n', data: 'n' },
    { label: '1', data: '1' },
    { label: '2', data: '2' },
    { label: '3', data: '3' },
    { label: 'Enter', data: '\r' },
    { label: 'Esc', data: '\x1b' },
    { label: '↑', data: '\x1b[A' },
    { label: '↓', data: '\x1b[B' },
    { label: 'Ctrl+C', data: '\x03' },
    { label: 'Tab', data: '\t' },
  ];

  term!: Terminal;
  private fit!: FitAddon;
  private ws?: WebSocket;
  private destroyed = false;
  private backoff = 1000;
  private resizeObserver?: ResizeObserver;
  private resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  private urlScanTimeout: ReturnType<typeof setTimeout> | null = null;
  private fitTimers: ReturnType<typeof setTimeout>[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  ngAfterViewInit(): void {
    this.term = new Terminal({
      scrollback: 10000,
      cursorBlink: true,
      rightClickSelectsWord: true,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
      fontSize: window.innerWidth < 768 ? 11 : 13,
      theme: {
        background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff',
        black: '#484f58',   brightBlack:   '#6e7681',
        red: '#ff7b72',     brightRed:     '#ffa198',
        green: '#3fb950',   brightGreen:   '#56d364',
        yellow: '#d29922',  brightYellow:  '#e3b341',
        blue: '#58a6ff',    brightBlue:    '#79c0ff',
        magenta: '#bc8cff', brightMagenta: '#d2a8ff',
        cyan: '#39c5cf',    brightCyan:    '#56d4dd',
        white: '#b1bac4',   brightWhite:   '#f0f6fc',
      },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.termRef.nativeElement);
    this.fit.fit();

    this.term.onData((data) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    });
    this.term.onWriteParsed(() => {
      if (this.autoScroll) this.term.scrollToBottom();
      if (this.urlScanTimeout) clearTimeout(this.urlScanTimeout);
      this.urlScanTimeout = setTimeout(() => this.scanUrls(), 300);
    });

    this.setupResize();
    this.connect();
  }

  private connect(): void {
    if (this.destroyed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${encodeURIComponent(this.container)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.connected = true;
      this.sendResize();
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.term.write(new Uint8Array(e.data));
      else if (typeof e.data === 'string') this.term.write(e.data);
    };
    ws.onclose = () => { this.connected = false; this.scheduleReconnect(); };
    ws.onerror = () => { this.connected = false; };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10000);
  }

  private setupResize(): void {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
      this.resizeTimeout = setTimeout(() => this.doFit(), 50);
    });
    this.resizeObserver.observe(this.termRef.nativeElement);
  }

  doFit(): void {
    this.fit.fit();
    this.sendResize();
    this.fitTimers.push(setTimeout(() => { this.fit.fit(); this.sendResize(); }, 100));
    this.fitTimers.push(setTimeout(() => { this.fit.fit(); this.sendResize(); }, 500));
  }

  private sendResize(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
    }
  }

  private scanUrls(): void {
    const urlRegex = /https?:\/\/[^\s\x1b\]'"<>]+/g;
    const buf = this.term.buffer.active;
    const found: DetectedUrl[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y)?.translateToString(true) ?? '';
      let m: RegExpExecArray | null;
      urlRegex.lastIndex = 0;
      while ((m = urlRegex.exec(line)) !== null) {
        const url = m[0].replace(/[.,;)\]]+$/, '');
        found.push({ url, row: y - buf.viewportY });
      }
    }
    this.detectedUrls = found;
  }

  onMouseMove(ev: MouseEvent): void {
    const host = this.termRef.nativeElement;
    const rect = host.getBoundingClientRect();
    const cellHeight = rect.height / this.term.rows;
    if (cellHeight <= 0) { this.hoveredRow = null; return; }
    this.hoveredRow = Math.floor((ev.clientY - rect.top) / cellHeight);
  }

  sendKey(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  openUrl(url: string): void {
    window.open(url, '_blank', 'noopener');
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
    if (this.urlScanTimeout) clearTimeout(this.urlScanTimeout);
    this.fitTimers.forEach((t) => clearTimeout(t));
    try { this.resizeObserver?.disconnect(); } catch {}
    try { this.ws?.close(); } catch {}
    try { this.term?.dispose(); } catch {}
  }
}
