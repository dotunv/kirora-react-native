import { EMPTY_STATE, type KiroraBackend, type KiroraState } from './backend';
import { KiroraApiError, KiroraError, UserTokenError } from './errors';
import { isPlainObject, jsonSnapshot, NotJsonError } from './json';
import type { BeforeSendEvent, KiroraOptions, NotificationData, PushPermission, PushStatus } from './types';
import { SDK_VERSION } from './version';

/** The methods of the `KiroraSdk` native module: `android/src/main/java/io/kirora/reactnative`, `ios/`. */
export interface NativeKiroraModule {
  configure(options: NativeOptions): Promise<void>;
  identify(token: string | null): Promise<void>;
  logout(): Promise<void>;
  track(name: string, propertiesJson: string): void;
  trackScreenView(name: string): void;
  setTrackingConsent(granted: boolean): void;
  /** Resolves once Kirora recorded it; rejects like `identify`. */
  setPushConsent(granted: boolean): Promise<void>;
  requestPushPermission(): Promise<PushPermission>;
  flush(): Promise<void>;
  /** Null when there is no client, or its state can't be read. */
  getState(): Promise<KiroraState | null>;
  onNewPushToken(token: string): void;
  getPushStatus(): Promise<PushStatus>;
  setPushEnabled(enabled: boolean): Promise<void>;
  destroy(): void;
  /** Answers a `KiroraTokenRequest` event: a token, or an error message when `fetchUserToken` failed. */
  resolveToken(requestId: string, token: string | null, error: string | null): void;
  /**
   * Answers a `KiroraForegroundNotification` event (show the push, or hold it back) or a
   * `KiroraDeepLink` event (whether the app opened the link itself).
   */
  resolveAnswer(requestId: string, answer: boolean): void;
  /** Starts (or stops) `KiroraNotificationClicked` / `KiroraNotificationReceived` events; taps that arrived earlier follow at once. */
  setNotificationEvents(clicked: boolean, received: boolean): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export interface NativeOptions {
  clientKey: string;
  apiUrl: string;
  push: boolean;
  pushAppId: string | null;
  requireTrackingConsent: boolean;
  trackSessions: boolean;
  trackAppLifecycle: boolean;
  logLevel: string;
  hasTokenProvider: boolean;
  smallIcon: string | null;
  accentColor: string | null;
  channelId: string | null;
  channelName: string | null;
  hasForegroundHandler: boolean;
  hasDeepLinkHandler: boolean;
  /** This package's version, sent as `Kirora-SDK: kirora-react-native/<version>`. */
  sdkVersion: string;
}

export interface NativeEventEmitterLike {
  addListener(eventName: string, listener: (event: any) => void): { remove(): void };
}

const TOKEN_REQUEST_EVENT = 'KiroraTokenRequest';
const FOREGROUND_EVENT = 'KiroraForegroundNotification';
const CLICKED_EVENT = 'KiroraNotificationClicked';
const RECEIVED_EVENT = 'KiroraNotificationReceived';
const DEEP_LINK_EVENT = 'KiroraDeepLink';

/** A question from the native SDK: `expiresAt` is when it stops waiting and acts on its own. */
interface NativeAsk {
  requestId: string;
  expiresAt?: number;
}

/**
 * Hands every call to the native Kirora Android or iOS SDK. `fetchUserToken`, `handleDeepLink`
 * and `onForegroundNotification` stay in JavaScript: the native SDK asks with an event, and the
 * answer goes back with `resolveToken` or `resolveAnswer`. `beforeSend`
 * runs here, on the events the app tracks, before they cross. Notification opens are reported
 * by the native SDK on its own.
 *
 * Every call goes to the native module at once, not after `configure` settles: the module runs
 * calls in order, after the `configure` this client sent, so a call reaches the client that was
 * current when it was made, even if a newer one replaces it right after (a withdrawn consent).
 */
export class NativeBackend implements KiroraBackend {
  private readonly configured: Promise<void>;
  private readonly subscriptions: Array<{ remove(): void }> = [];
  private readonly clickListeners = new Set<(data: NotificationData) => void>();
  private readonly receivedListeners = new Set<(data: NotificationData) => void>();
  private destroyed = false;
  private inBeforeSend = false;
  /** Why the native setup failed, for `identify` to reject with. */
  private setupError?: KiroraError;
  private readonly beforeSend: KiroraOptions['beforeSend'];
  private readonly logErrors: boolean;

  constructor(
    options: KiroraOptions & { clientKey: string },
    private readonly native: NativeKiroraModule,
    private readonly emitter: NativeEventEmitterLike
  ) {
    this.beforeSend = typeof options.beforeSend === 'function' ? options.beforeSend : undefined;
    this.logErrors = options.logLevel !== 'none';
    const fetchUserToken = options.fetchUserToken;
    if (fetchUserToken) {
      // An empty answer fails the request on the native side.
      this.subscriptions.push(emitter.addListener(TOKEN_REQUEST_EVENT, (event: NativeAsk) => {
        Promise.resolve()
          .then(fetchUserToken)
          .then(
            (token) => this.native.resolveToken(event.requestId, token || null, null),
            (e) => this.native.resolveToken(event.requestId, null, e instanceof Error ? e.message : String(e))
          );
      }));
    }
    const push = options.push;
    const pushOptions = typeof push === 'object' ? push : undefined;
    const foreground = pushOptions?.onForegroundNotification;
    if (foreground) {
      this.answer(FOREGROUND_EVENT, 'onForegroundNotification', true,
        async (event: NativeAsk & { data: NotificationData }) => (await foreground(event.data)) !== false);
    }
    const handleDeepLink = typeof options.handleDeepLink === 'function' ? options.handleDeepLink : undefined;
    if (handleDeepLink) {
      this.answer(DEEP_LINK_EVENT, 'handleDeepLink', false,
        (event: NativeAsk & { url: string }) => handleDeepLink(event.url) === true);
    }
    // The native module sends these only once `setNotificationEvents` turned them on.
    this.subscriptions.push(
      emitter.addListener(CLICKED_EVENT, (data: NotificationData) => this.deliver(this.clickListeners, data)),
      emitter.addListener(RECEIVED_EVENT, (data: NotificationData) => this.deliver(this.receivedListeners, data))
    );
    this.configured = native
      .configure({
        clientKey: options.clientKey,
        apiUrl: options.apiUrl ?? 'https://api.kirora.io',
        push: !!push,
        pushAppId: pushOptions?.pushAppId ?? null,
        requireTrackingConsent: options.requireTrackingConsent ?? false,
        trackSessions: options.trackSessions ?? true,
        trackAppLifecycle: options.trackAppLifecycle ?? false,
        logLevel: options.logLevel ?? 'error',
        hasTokenProvider: !!fetchUserToken,
        smallIcon: pushOptions?.smallIcon ?? null,
        accentColor: pushOptions?.accentColor ?? null,
        channelId: pushOptions?.channelId ?? null,
        channelName: pushOptions?.channelName ?? null,
        hasForegroundHandler: !!foreground,
        hasDeepLinkHandler: !!handleDeepLink,
        sdkVersion: SDK_VERSION
      })
      .catch((e) => {
        this.setupError = errorFromNative(e);
        this.error('native setup failed', this.setupError);
      });
  }

  /**
   * Answers the native SDK's `event` with `handler`'s result: `fallback` when it throws or
   * rejects. Not asked once the native SDK stopped waiting: it has acted by then (opened the
   * link, shown the push), and the app's callback would act a second time.
   */
  private answer<E extends NativeAsk>(
    event: string,
    name: string,
    fallback: boolean,
    handler: (event: E) => boolean | Promise<boolean>
  ): void {
    this.subscriptions.push(
      this.emitter.addListener(event, (ask: E) => {
        if (typeof ask.expiresAt === 'number' && Date.now() > ask.expiresAt) {
          this.error(`${name} not asked: JavaScript got the request after the native SDK stopped waiting`);
          return;
        }
        Promise.resolve()
          .then(() => handler(ask))
          .then(
            (answer) => this.native.resolveAnswer(ask.requestId, answer),
            (e) => {
              this.error(`${name} threw`, e);
              this.native.resolveAnswer(ask.requestId, fallback);
            }
          );
      })
    );
  }

  /**
   * Sends a call at once (see the class), then answers what the native SDK did, mapped to the
   * SDK's errors; a failed setup rejects with why. `whenDestroyed` once this client is destroyed.
   */
  private async call<T>(send: () => Promise<T>, whenDestroyed: T): Promise<T> {
    if (this.destroyed) return whenDestroyed;
    const pending = send();
    await this.configured;
    if (this.setupError) {
      pending.catch(() => undefined);
      throw this.setupError;
    }
    try {
      return await pending;
    } catch (e) {
      throw errorFromNative(e);
    }
  }

  /** `call`, logging instead of rejecting. */
  private quietly(what: string, send: () => Promise<void>): Promise<void> {
    return this.call(send, undefined).catch((e) => this.error(`${what} failed`, e));
  }

  /** Rejects with what the native SDK threw: `UserTokenError`, `KiroraApiError` or `KiroraError`. */
  identify(token?: string): Promise<void> {
    return this.call(() => this.native.identify(token || null), undefined);
  }

  /** Never rejects. */
  logout(): Promise<void> {
    return this.quietly('logout', () => this.native.logout());
  }

  track(name: string, properties?: Record<string, unknown>): void {
    if (this.destroyed) return;
    const event = this.prepare(name, properties ?? {});
    if (event) this.native.track(event.name, JSON.stringify(event.properties));
  }

  trackScreenView(name: string): void {
    if (this.destroyed) return;
    if (typeof name !== 'string' || name === '') {
      this.error('Screen view not tracked: it needs a name');
      return;
    }
    if (!this.beforeSend) {
      this.native.trackScreenView(name);
      return;
    }
    // Through beforeSend like any app event; the native SDK still names it `Screen Viewed`.
    this.track('Screen Viewed', { name });
  }

  setTrackingConsent(granted: boolean): void {
    if (!this.destroyed) this.native.setTrackingConsent(granted);
  }

  /** Resolves once Kirora recorded the choice; rejects, as `identify` does, when it didn't. */
  setPushConsent(granted: boolean): Promise<void> {
    return this.call(() => this.native.setPushConsent(granted), undefined);
  }

  requestPushPermission(): Promise<PushPermission> {
    return this.call(() => this.native.requestPushPermission(), 'unsupported');
  }

  getPushStatus(): Promise<PushStatus> {
    return this.call(() => this.native.getPushStatus(), 'unsupported');
  }

  /** Never rejects. */
  setPushEnabled(enabled: boolean): Promise<void> {
    return this.quietly(`Turning push ${enabled ? 'on' : 'off'}`, () => this.native.setPushEnabled(enabled));
  }

  /** Never rejects. */
  flush(): Promise<void> {
    return this.quietly('flush', () => this.native.flush());
  }

  /** Never rejects: the empty state when it can't be read. */
  async getState(): Promise<KiroraState> {
    try {
      return { ...EMPTY_STATE, ...(await this.call(() => this.native.getState(), null)) };
    } catch (e) {
      this.error("Couldn't read the state", e);
      return { ...EMPTY_STATE };
    }
  }

  /**
   * Stops this client's listeners; the native SDK keeps what waits. `stopNative` when it is the
   * current client: a replaced one leaves the module to the client that set it up again.
   */
  destroy(stopNative: boolean): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.subscriptions.forEach((s) => s.remove());
    if (stopNative) {
      this.native.setNotificationEvents(false, false);
      this.native.destroy();
    }
  }


  /**
   * The event as it goes to the native SDK: properties copied as JSON now, then `beforeSend`.
   * Undefined when it is dropped. Only the failure's kind is logged, never the event. Getters
   * of the app's objects run only inside guards: one that throws drops the event.
   */
  private prepare(name: string, properties: unknown): { name: string; properties: Record<string, unknown> } | undefined {
    if (this.inBeforeSend) {
      this.error('Not tracked: called from beforeSend');
      return undefined;
    }
    if (typeof name !== 'string' || name === '' || !isPlainObject(properties)) {
      this.error('Not tracked: needs a name, and properties as an object');
      return undefined;
    }
    let snapshot: Record<string, unknown>;
    try {
      snapshot = jsonSnapshot(properties) as Record<string, unknown>;
    } catch (e) {
      this.error(`${name} not tracked: its properties hold ${e instanceof NotJsonError ? e.message : 'something JSON has no form for'}`);
      return undefined;
    }
    if (!this.beforeSend) return { name, properties: snapshot };
    let answer: unknown;
    this.inBeforeSend = true;
    try {
      answer = this.beforeSend({ name, properties: snapshot, context: {} });
    } catch {
      this.error(`${name} not tracked: beforeSend threw`);
      return undefined;
    } finally {
      this.inBeforeSend = false;
    }
    if (answer === null) return undefined;
    try {
      if (typeof (answer as PromiseLike<unknown> | undefined)?.then === 'function') {
        Promise.resolve(answer).catch(() => undefined);
        this.error(`${name} not tracked: beforeSend must answer at once, not later`);
        return undefined;
      }
      const properties = isPlainObject(answer) ? (answer as Partial<BeforeSendEvent>).properties ?? {} : undefined;
      if (!isPlainObject(properties)) {
        this.error(`${name} not tracked: beforeSend must answer an event or null`);
        return undefined;
      }
      return { name, properties: jsonSnapshot(properties) as Record<string, unknown> };
    } catch {
      this.error(`${name} not tracked: reading beforeSend's answer threw, or it holds something JSON has no form for`);
      return undefined;
    }
  }

  /** Hands a notification to the app's listeners; one that throws doesn't stop the others. */
  private deliver(listeners: Set<(data: NotificationData) => void>, data: NotificationData): void {
    listeners.forEach((listener) => {
      try {
        listener(data);
      } catch (e) {
        this.error('error in a notification listener', e);
      }
    });
  }

  private error(message: string, cause?: unknown): void {
    if (this.logErrors) console.error(`[Kirora] ${message}`, cause ?? '');
  }

  onNewPushToken(token: string): void {
    if (typeof token !== 'string' || token === '') {
      this.error('onNewPushToken needs the token');
      return;
    }
    if (!this.destroyed) this.native.onNewPushToken(token);
  }

  onNotificationClicked(listener: (data: NotificationData) => void): () => void {
    return this.listen(this.clickListeners, listener);
  }

  onNotificationReceived(listener: (data: NotificationData) => void): () => void {
    return this.listen(this.receivedListeners, listener);
  }

  private listen(
    listeners: Set<(data: NotificationData) => void>,
    listener: (data: NotificationData) => void
  ): () => void {
    if (this.destroyed) return () => undefined;
    listeners.add(listener);
    this.syncNotificationEvents();
    return () => {
      listeners.delete(listener);
      this.syncNotificationEvents();
    };
  }

  /** Never after destroy: the native module may serve a newer client by then. */
  private syncNotificationEvents(): void {
    if (!this.destroyed) this.native.setNotificationEvents(this.clickListeners.size > 0, this.receivedListeners.size > 0);
  }
}

/**
 * A native module's rejection as one of the SDK's errors. The modules reject with a code
 * (`USER_TOKEN_ERROR`, `KIRORA_API_ERROR` with `status`, `code` and `retryAfterMs` in `userInfo`,
 * anything else for a setup or network problem) and the native SDK's message.
 */
export function errorFromNative(e: unknown): KiroraError {
  const native = (e ?? {}) as { code?: unknown; message?: unknown; userInfo?: Record<string, unknown> | null };
  const message = (typeof native.message === 'string' ? native.message : String(e)).replace(/^Kirora: /, '');
  const info = native.userInfo ?? {};
  switch (native.code) {
    case 'USER_TOKEN_ERROR':
      return new UserTokenError(message, e);
    case 'KIRORA_API_ERROR':
      return new KiroraApiError(
        typeof info.status === 'number' ? info.status : 0,
        typeof info.code === 'string' ? info.code : undefined,
        message,
        typeof info.retryAfterMs === 'number' ? info.retryAfterMs : undefined
      );
    default:
      return new KiroraError(message, e);
  }
}
