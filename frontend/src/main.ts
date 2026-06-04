import { bootstrapApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { AppComponent } from './app/app.component';

// Zoneless change detection (PRD §5.1): the app drives updates exclusively
// through signals and the rAF-throttled render scheduler — no zone.js polling.
bootstrapApplication(AppComponent, {
  providers: [provideZonelessChangeDetection()],
}).catch((err) => console.error(err));
