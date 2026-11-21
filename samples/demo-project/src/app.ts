import { readFileSync } from 'node:fs';

import { UserService } from './services/userService';
import formatDate from './utils/date';
import * as log from './utils/logger';

/** Builds the application. */
export function createApp(): { readonly version: string } {
  log.info('Creating app');
  startServer();
  return { version: readFileSync('VERSION', 'utf8') };
}

/** Boots the services and reports the start time. */
function startServer(): void {
  UserService.bootstrap();
  log.info(`Started at ${formatDate(new Date())}`);
}
