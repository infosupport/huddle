import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'relTime', standalone: true })
export class RelTimePipe implements PipeTransform {
  transform(unix: number): string {
    const d = Math.floor(Date.now() / 1000) - unix;
    if (d < -60) return `over ${Math.ceil(-d / 60)}m`;
    if (d < 0) return `over ${-d}s`;
    if (d < 5) return 'just now';
    if (d < 60) return `${d}s`;
    if (d < 3600) return `${Math.floor(d / 60)}m`;
    if (d < 86400) return `${Math.floor(d / 3600)}h`;
    return `${Math.floor(d / 86400)}d`;
  }
}
