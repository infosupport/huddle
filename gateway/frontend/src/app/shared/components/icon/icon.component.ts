import { Component, input, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { ICONS } from '../../icons/icons';

@Component({
  selector: 'app-icon',
  standalone: true,
  template: `<svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"
    [attr.stroke-width]="strokeWidth()" [innerHTML]="html()"></svg>`,
  styles: [':host { display: inline-flex; align-items: center; line-height: 0; }'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IconComponent {
  name        = input.required<string>();
  size        = input<number>(16);
  strokeWidth = input<number>(2);

  private san = inject(DomSanitizer);

  html = computed(() =>
    this.san.bypassSecurityTrustHtml(ICONS[this.name()] ?? '')
  );
}
