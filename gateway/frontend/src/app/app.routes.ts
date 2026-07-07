import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  { path: 'dashboard', loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.DashboardComponent) },
  { path: 'containers', loadComponent: () => import('./pages/containers/containers.component').then(m => m.ContainersComponent) },
  { path: 'container/:name', loadComponent: () => import('./pages/container-detail/container-detail.component').then(m => m.ContainerDetailComponent) },
  { path: 'firewall', loadComponent: () => import('./pages/firewall/firewall.component').then(m => m.FirewallComponent) },
  { path: 'docker-access', loadComponent: () => import('./pages/docker-access/docker-access.component').then(m => m.DockerAccessComponent) },
{ path: 'network-log', loadComponent: () => import('./pages/audit/audit.component').then(m => m.AuditComponent) },
  { path: 'settings', loadComponent: () => import('./pages/settings/settings.component').then(m => m.SettingsComponent) },
  { path: 'extensions', loadComponent: () => import('./pages/extensions/extensions.component').then(m => m.ExtensionsPageComponent) },
  { path: 'extensions/:id/settings', loadComponent: () => import('./pages/extensions/settings/extension-settings.component').then(m => m.ExtensionSettingsComponent) },
  { path: 'extensions/view/:id', loadComponent: () => import('./pages/extensions/view/extension-view.component').then(m => m.ExtensionViewComponent) },
  { path: 'extensions/view/:id/:repo', loadComponent: () => import('./pages/extensions/view/extension-view.component').then(m => m.ExtensionViewComponent) },
{ path: '**', redirectTo: 'dashboard' },
];
