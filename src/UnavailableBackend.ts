import { EMPTY_STATE, type KiroraBackend, type KiroraState } from './backend';
import type { PushPermission, PushStatus } from './types';

const UNAVAILABLE_MESSAGE =
  "[Kirora] The native module isn't linked, so Kirora does nothing. It needs native code: use a " +
  'development build (`npx expo run:ios`, `run:android`) rather than Expo Go, then rebuild the app ' +
  'after installing. In tests, mock it with `jest.mock(\'@kirora/react-native\', () => require(\'@kirora/react-native/jest\'))`.';

/**
 * Where the native module isn't linked (Expo Go, a build made before installing): every call is
 * a safe no-op, so the app keeps working, and one error says why nothing is sent.
 */
export class UnavailableBackend implements KiroraBackend {
  constructor(logErrors: boolean) {
    if (logErrors) console.error(UNAVAILABLE_MESSAGE);
  }

  async identify(): Promise<void> {}
  async logout(): Promise<void> {}
  track(): void {}
  trackScreenView(): void {}
  setTrackingConsent(): void {}
  async setPushConsent(): Promise<void> {}
  async requestPushPermission(): Promise<PushPermission> {
    return 'unsupported';
  }
  async getPushStatus(): Promise<PushStatus> {
    return 'unsupported';
  }
  async setPushEnabled(): Promise<void> {}
  async flush(): Promise<void> {}
  destroy(): void {}
  async getState(): Promise<KiroraState> {
    return { ...EMPTY_STATE };
  }
  onNewPushToken(): void {}
  onNotificationClicked(): () => void {
    return () => undefined;
  }
  onNotificationReceived(): () => void {
    return () => undefined;
  }
}
