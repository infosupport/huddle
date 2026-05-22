import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'fmtBytes', standalone: true })
export class FmtBytesPipe implements PipeTransform {
  transform(b: number): string {
    if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
    if (b > 1e6) return (b / 1e6).toFixed(0) + ' MB';
    return (b / 1e3).toFixed(0) + ' KB';
  }
}
