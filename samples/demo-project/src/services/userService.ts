import { save as persist } from '../data/repository';
import { validateEmail } from '../utils';
import * as log from '../utils/logger';

/** Registers users. */
export class UserService {
  /** Creates the service and registers a sample user. */
  static bootstrap(): void {
    new UserService().register('ada@example.com');
  }

  /** Validates, stores and notifies a new user. */
  register(email: string): boolean {
    if (!validateEmail(email)) {
      log.warn(`Invalid email: ${email}`);
      return false;
    }
    persist({ email });
    this.notify(email);
    return true;
  }

  /** Sends a welcome notification. */
  private notify(email: string): void {
    log.info(`Welcome ${email}`);
  }
}
