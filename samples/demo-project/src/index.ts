import startLegacyServer from '../legacy/server';
import { createApp } from './app';

/** Application entry point. */
export function main(): void {
  createApp();
  startLegacyServer();
}
