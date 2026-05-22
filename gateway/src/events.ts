import { EventEmitter } from 'events';

export const stateEvents = new EventEmitter();

export function notifyStateChanged(): void {
  stateEvents.emit('changed');
}
