import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { installGlobalClientLogging, sendClientLog } from './app/core/services/client-log';

installGlobalClientLogging();

bootstrapApplication(App, appConfig)
  .catch((err) => {
    console.error(err);
    sendClientLog('error', `bootstrap failed: ${err?.message ?? err}`, err?.stack);
  });
