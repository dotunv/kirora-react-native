# React Native SDK review

**Reviewed:** 17 November 2026. **Verdict: changes required before production release.**
The TypeScript build and typecheck pass, package contents include both bridges, and the
Android bridge sources compile against the locally available dependencies. However,
client replacement can discard a tracking refusal, event serialization has fidelity and
exception-handling defects, and state reporting does not preserve the shared contract.
A stale local Android artifact found initially was refreshed during the audit; its
replacement passes the backend context check. That issue is recorded as resolved below.

## Scope and evidence

The requested `kirora/react-native` directory does not exist. This review covers
`kirora/kirora-react-native`: JavaScript/TypeScript, Android Kotlin, iOS Swift/Objective-C,
autolinking, native dependency declarations, packaging, the Jest mock and existing test
sources. The authority is the shared [SDK interface](../../../omnichannel/docs/sdk-interface.md),
including its explicit wrapper exceptions and the concurrent 17 November additions
for mobile context and Android notification appearance. Customer.io and Iterable comparisons below
use official React Native sources accessed on the review date.

This checkout has no commits and contains staged, unstaged and untracked work. A file
hash snapshot was captured before review; existing staged deletions were preserved.
Verification used an isolated copy at `/private/tmp/kirora-react-native-review-20261117`.
Only this report and the root README are delivered changes. No SDK implementation,
configuration, lockfile or test-suite files were edited. **The existing test suite was
not run**, as requested. Standalone probes are temporary programs, not new suite tests.

“Reproduced” below means execution of the compiled JavaScript, or an actual native
artifact serializer and backend schema. Native bridge lifecycle conclusions identified
as source analysis were not exercised on a device. P1 blocks the affected integration's
release; P2 is a material contract/correctness defect. Proposed verification cases are
future implementation work, not claims of coverage added by this review.

## Findings

### R01 — P1: replacing a client can discard an explicit tracking withdrawal

**Reproduced with compiled JavaScript and a recording native-module stand-in.**
[NativeBackend.setTrackingConsent](../src/NativeBackend.ts), lines 213–215, always
schedules the native setter through `this.configured.then(...)`, even after configuration
has completed. Its continuation skips the setter when the backend is destroyed.
[Kirora's constructor](../src/Kirora.ts) destroys the previous instance synchronously.

Concrete sequence, with A already configured:

```ts
first.setTrackingConsent(false);
const second = new Kirora({ clientKey: sameClientKey });
```

The first call returns without forwarding the choice. Constructing the replacement
sets `first.destroyed = true` before its microtask executes, so the withdrawal disappears.
In the probe, zero native withdrawal calls occurred and the stand-in's previously granted
native choice remained true. With tracking allowed by default, the replacement can
continue collection without the refusal ever reaching persistent consent state.

This is not evidence of a network leak observed on a device. It demonstrates that the
wrapper fails to convey the user's refusal at all. The spec requires the fresh choice
to take effect immediately and remembered refusal to survive client lifetime changes.

**Required change:** make pending consent choices survive same-namespace replacement, or
forward them before treating the old client as disposable. Bind deferred choices to the
workspace/API namespace so a correction cannot apply A's preference to another workspace.
Verify an already-configured client, pending configuration, immediate replacement and
explicit destroy followed by recreation. Document any API change before implementing it.

### R02 — P2: the JSON snapshot loses an ordinary `__proto__` property

**Reproduced through both `jsonSnapshot` and public `track`.**
[json.ts](../src/json.ts), lines 30–33, copies members using assignment into `{}`.
Assigning `__proto__` changes that object's prototype instead of creating the original
own JSON member.

Input created with `JSON.parse`:

```json
{"__proto__":{"tier":"gold"},"order_id":"ORD-1042"}
```

The actual bridge payload became:

```json
{"order_id":"ORD-1042"}
```

The copy also had a different prototype. This silently changes valid JSON, violating the
capture/snapshot contract. This probe does **not** demonstrate global prototype pollution,
server exploitation or arbitrary code execution.

**Required change:** construct JSON objects without inherited setters, or define members
as own data properties. Preserve object members exactly, including nested `__proto__`,
while retaining current rejection of cycles and non-finite numbers. Check both initial
property copying and the snapshot taken after `beforeSend`.

### R03 — P2: state reporting can fail and omits Android's memory queue

**JavaScript failure reproduced; Android count defect established by source analysis.**
[NativeBackend.getState](../src/NativeBackend.ts), lines 276–283, maps a native rejection
and rethrows it. A simulated native storage-read failure therefore made the actual
public API reject with `KiroraError`. The shared contract explicitly says `getState`
never fails; the existing wrapper tests intentionally expect rejection, so those tests
do not establish conformance to that requirement.

The [Android bridge](../android/src/main/java/io/kirora/reactnative/KiroraSdkModule.kt),
lines 176–189, separately reconstructs state from individual getters and obtains queue
count through `getQueuedEventCountFlow()?.first()`. That flow reads Room, not the
native SDK's combined EventStore. It reports zero when the database is unavailable,
even if fallback memory contains events, and excludes memory records when both stores
contain work. Getter/flow failures also reach `withKirora` and become rejections.

The native Android SDK already provides a safer combined snapshot:
[Kirora.getState](../../kirora-android/kirora-sdk/src/main/java/com/kirora/androidsdk/Kirora.kt),
around line 237. The iOS bridge appropriately delegates to its native snapshot.

**Required change:** forward the native Android snapshot and preserve its safe-read
semantics. Make the JS snapshot API return documented empty/unreadable values with a
safe diagnostic when the bridge cannot read state. Verify absent Room, mixed disk and
memory records, a read failure, teardown and an unavailable module. Do not add a second
queue-count implementation in the wrapper.

### R04 — P2: inspection of application objects can throw out of `track`

**Reproduced with compiled public JavaScript.**
[NativeBackend.prepare](../src/NativeBackend.ts), lines 310–338, performs several
property accesses outside its exception guards. `isPlainObject` calls
`Object.prototype.toString`, which can execute an application's `Symbol.toStringTag`
getter. After a hook returns, reading `answer.then` and checking its properties can
also execute getters outside the guarded callback invocation.

A properties object with a throwing `Symbol.toStringTag` getter caused public `track`
to throw `tag getter failed`. A `beforeSend` result with a throwing `then` getter
caused `hook then getter failed` to escape. No native-module failure was needed.
These are unusual inputs, but the promised behavior is to drop unrepresentable events
with a diagnostic, never throw into the host app.

**Required change:** guard all caller-controlled inspection and copying, including hook
result validation and thenable detection. Emit a failure-kind diagnostic without the
exception's potentially sensitive payload. Verify that a subsequent valid event still
crosses the bridge after each failure.

### R05 — P2: an expired deep-link request can still invoke the application's router

**Native timeout path checked by source analysis; late JS dispatch reproduced with a
simulated expired request.** [NativeBackend's deep-link listener](../src/NativeBackend.ts),
around lines 130–145, invokes `handleDeepLink` for every delivered request without an
expiry or generation check. Native request events contain a request ID and URL but no
deadline. The [iOS `ask` implementation](../ios/KiroraSdkModule.swift), lines 288–305,
and Android's corresponding helper stop waiting after 1.5 seconds and use the fallback.

If the JavaScript thread is busy long enough, native code can open the URL through its
fallback before the emitted request is delivered. When JS resumes, it still calls the
application's router. Ignoring the late `resolveDeepLink` answer does not undo that
routing side effect: the browser and app can both navigate for the same tap.
The standalone JS dispatch confirmed that a request identified by the harness as already
expired still invoked the application callback. It did not reproduce an actual device
stall or observe two platform navigations.

**Required change:** carry a request deadline/lifetime and reject expired requests before
invoking application code. Keep handlers fast; work already performed by an app callback
cannot be canceled retrospectively. Verify delayed event delivery, replacement/reload,
normal routing and fallback with no handler. Preserve the 1.5-second native fallback
rather than extending it indefinitely.

### R06 — Resolved during review: stale local Android context artifact

**Initially reproduced, then rechecked after concurrent native publication.**
[android/build.gradle](../android/build.gradle), lines 33–40, defaults native dependencies
to `0.1.0` and searches `mavenLocal()`. The initially installed core AAR serialized
`app`, `network`, `os`, `screen` and extra device fields that the backend schema then
rejected. A temporary Java program invoked the actual artifact serializer; its output
was checked against the imported backend `eventContextSchema`, not a hand-written schema.
The initial extracted core classes had SHA-256
`72df9071aae91536cf2675d84af33a81adac1d0e944f377f9069e83e3b993006`.

During review the Android source and local Maven artifact changed, and the shared spec
and backend added an approved mobile context shape. Network details remain excluded.
The refreshed artifact's context was serialized again and **passed** the current backend
validator. It contains the reduced core context shape; the native working tree is also
being extended with the newly approved mobile fields. These are separate snapshots.
The initial incompatibility is therefore **not an outstanding finding against the
refreshed artifact**, and no claim is made that a source correction is still missing.

This is still useful release evidence: a version label reused in local development can
refer to different bytes. Resolve and validate the exact artifact used by the consuming
app, record tested native versions and verify the deployed backend accepts its shape.
Public Maven publication, backend deployment and complete event ingestion were not
verified. Do not turn a passing schema check into a claim of live delivery.

## Contract and release assessment

| Area | Assessment |
| --- | --- |
| Architecture | Correct overall direction: queues, sessions, identity, consent, retries and push remain native. No separate TypeScript delivery engine exists in the working tree. |
| Public methods/options | Core methods and error classes are exported. Android notification appearance and foreground options are native additions. `getState` needs R03. |
| Wrapper redaction | Synchronous hook runs on explicit app events before forwarding; the spec explicitly exempts native automatic events. Their bypass is not a finding. Context is empty and returned context is ignored; the shared wording should explicitly define this narrower wrapper guarantee. |
| Token round trip | Request IDs, native timeouts and cancellation hooks exist. JS late answers can still arrive, but native code owns acceptance. No new token-authentication engine is needed in JS. |
| Launch/teardown | Android launch provider and iOS `+load` install push integration before JS. Invalidation calls `wrapperDetached`; explicit destroy uses the distinct no-handler behavior. These are useful source-level implementations, not device validation. |
| Unavailable runtime | Expo Go/missing module correctly gets safe no-ops, unsupported push and `isAvailable = false`, as explicitly required by the spec. A resolved no-op is not successful server consent. |
| Notifications | Native operational reports remain native. Click listeners return unsubscribe functions; the received callback is Android-only. iOS delivered reporting needs a service extension. |
| Android packaging | Both native core and FCM artifacts are unconditional dependencies, even with `push: false`; Firebase and its notification permission remain in the dependency/manifest graph. Treat optional dependency separation as a product choice, not a missing spec requirement. |
| Compatibility | `react-native >=0.71.0` is broader than demonstrated evidence. There is no example host, architecture/version build matrix or CI workflow in this checkout. Dependency/toolchain and host minimum requirements need a verified release matrix. |
| Distribution | Package includes compiled JS/declarations, native sources, podspec, autolinking and Jest mock, excluding test directories. Public npm, CocoaPods and Maven installation were not established. |

Legacy bridges are not automatically broken on the New Architecture: React Native
explicitly provides interoperability layers. Kirora uses `NativeModules`,
`ReactContextBaseJavaModule` and `RCTEventEmitter`, without a code-generated TurboModule
spec. This means interoperability must be demonstrated in host builds, rather than
claiming either full New Architecture support or incompatibility from source alone.
See [React Native's native-platform guidance](https://reactnative.dev/docs/native-platform).

Additional release gaps: the npm package is `UNLICENSED` with no license file, so no open
source license should be invented in the README; the Jest root entry has no corresponding
root declaration file for typed direct subpath imports; and release notes do not record
tested native SDK versions. The shipped mock is an interface/call-recording mock and
does not simulate state transitions, persistence, authentication or native notifications.
None of these observations authorizes changing licensing or implementing new product scope.

## Comparison with Customer.io and Iterable

| Area | Customer.io | Iterable | Recommendation for Kirora |
| --- | --- | --- | --- |
| First integration | Separates installation, identify/track, push and in-app setup. [Quick start](https://docs.customer.io/integrations/sdk/react-native/quick-start-guide/) | Gives platform setup, initialization and an example application. [Installation](https://support.iterable.com/hc/en-us/articles/360045714132-Installing-Iterable-s-React-Native-SDK) | Keep one short JS start, then explicit Android/iOS native steps and a real consuming host. |
| Architecture/version support | Publishes minimum versions, New Architecture requirements and host CI versions. [Official repository](https://github.com/customerio/customerio-reactnative) | Documents New Architecture support and platform requirements. [Installation](https://support.iterable.com/hc/en-us/articles/360045714132-Installing-Iterable-s-React-Native-SDK) | Publish a measured compatibility matrix and tested native versions; a peer range is not a build result. |
| Identity | Documents identify before personalized messaging. [Quick start](https://docs.customer.io/integrations/sdk/react-native/quick-start-guide/) | Documents persisted identity, pre-fetched JWTs and explicit sign-out. [Identity](https://support.iterable.com/hc/en-us/articles/360045714152-Managing-User-Identity-with-Iterable-s-React-Native-SDK) | Retain Kirora's memory-only JWT model and explicit identify on authenticated startup; explain ownership and offline logout precisely. |
| Authentication | Uses its own connection credentials. [Quick start](https://docs.customer.io/integrations/sdk/react-native/quick-start-guide/) | Documents async auth handlers, refresh and JWT failures. [JWT guide](https://support.iterable.com/hc/en-us/articles/43901001355412-JWT-Authentication-with-Iterable-s-React-Native-SDK) | Keep token secrets on the server; make failed identify and failed marketing-choice saves visible. Do not copy a different vendor's credentials or token claims. |
| Link routing | Documents native push setup and acknowledged scene-routing integration. [Official repository](https://github.com/customerio/customerio-reactnative) | Gives a handled/unhandled URL callback contract. [Link guide](https://support.iterable.com/hc/en-us/articles/360046134911-Deep-Links-and-Custom-Actions-with-Iterable-s-React-Native-SDK) | Native fallback and JS routing need one clear owner, including late requests and cold starts (R05). |
| Expo | Provides a dedicated Expo integration. [Official Expo documentation](https://docs.customer.io/integrations/sdk/expo/getting-started/packages-options/) | Provides an Expo plugin and requires development builds. [Expo guide](https://support.iterable.com/hc/en-us/articles/37200225506196-Expo-Plugin-for-Iterable-s-React-Native-SDK) | State development-build requirements. A config plugin is a possible future convenience, not a current contract defect. |
| Product breadth | Includes push and in-app messaging. [Quick start](https://docs.customer.io/integrations/sdk/react-native/quick-start-guide/) | Includes push and in-app messaging. [Installation](https://support.iterable.com/hc/en-us/articles/360045714132-Installing-Iterable-s-React-Native-SDK) | Missing inbox/in-app UI is outside this spec. Fix consent, serialization and release validation first. |

The useful blueprint is a verifiable native installation, explicit lifecycle behavior,
short examples and versioned compatibility evidence. Competitor feature count does not
justify changing Kirora's shared API or adding another JS queue.

## Verification and limits

| Check | Result |
| --- | --- |
| TypeScript production build | Passed: `tsc -p tsconfig.build.json`, TypeScript 5.9.3. Output generated only in the isolated copy. |
| Typecheck | Passed: `tsc -p tsconfig.json --noEmit`, including existing test source types; no test runner invoked. |
| Package smoke check | `npm pack --ignore-scripts` passed after build; 44 files, both bridges, JS/types and mock present, test directories excluded. No publishing or registry lookup. |
| README examples | Passed strict TypeScript checking against the built declarations, using typed placeholders for host authentication and routing. |
| Android source compilation | Passed with Kotlin compiler 2.2.10 against cached React Native 0.88.0 debug AAR, local Kirora core 0.1.0 AAR, API 36 stubs and cached dependency jars. This is not a Gradle host build, autolinking run, R8 check or JNI/device test. |
| iOS | Swift frontend parse passed and podspec Ruby syntax passed. Full Xcode/CocoaPods tooling is unavailable in this environment; no semantic iOS compile, pod resolution, linking or simulator validation. |
| JS standalone probes | Reproduced lost withdrawal, `__proto__` data loss, escaped getter errors and `getState` rejection. A simulated expired event still invoked the deep-link callback. |
| Resolved-artifact wire check | Initial AAR context rejected; refreshed AAR context accepted by the current backend schema. No HTTP server, database or live delivery was involved. |
| Existing suite | Relevant sources read, not run or modified. Tests use a fake native module and cannot establish native integration coverage. |
| Push and lifecycle | No real APNs/FCM, permission prompt, extension, background/terminated launch, engine reload or physical-device tests. |

Native source fixes occurring during this review were treated separately from the cached
artifacts. Repository/homepage/issue-tracker metadata was added to `package.json`
concurrently; that metadata-only diff was inspected and preserved. Wrapper implementation
and test files were hash-checked before saving documentation. No claim is
made that the earlier native SDK review findings all remain open, or that their source
fixes have reached a particular released wrapper dependency.

## Recommended order

1. Preserve explicit consent choices across replacement (R01).
2. Correct snapshot fidelity, exception isolation and state delegation (R02–R04).
3. Prevent expired link requests from producing app routing side effects (R05).
4. Record resolved native release artifacts and retain the refreshed wire check (R06).
5. In a subsequent implementation task, run focused regressions and the existing suite;
   build real Android/iOS hosts across the declared RN/architecture range; verify
   autolinking, native dependency resolution, permission handling and cold push launches.

The rewritten README describes implemented behavior and the current limitations. These
findings are recommendations for implementation work; this review does not fix them.

## Resolution (17 November 2026)

Each finding was fixed after this review, in the same uncommitted working tree.

| Finding | Fix | Regression |
| --- | --- | --- |
| R01 | Every call goes to the native module at once instead of after `configure` settles (one `call` helper maps errors and a failed set-up for those that answer). Android's `configure` drops the previous client first, so calls after a failed set-up reach none. Both native modules run calls in order and configure synchronously, so a call reaches the client that was current when it was made, before a replacement's `configure`. No API change; no cross-workspace forwarding. | Consent and an event sent just before replacement arrive, in order. |
| R02 | `jsonSnapshot` defines members as own data properties (`Object.defineProperty`), so `__proto__` stays data at any depth. | `__proto__` from `JSON.parse` survives top-level and nested. |
| R03 | JS `getState` never rejects: a failed read logs the kind and returns the empty state, defined once in JS. Android forwards `Kirora.getState()` (safe reads, disk and memory count); both native modules resolve null when there is no client or the read fails. | A native read failure resolves the empty state. |
| R04 | `track` guards `prepare` as a whole: a throwing `Symbol.toStringTag`, `then` or other getter drops the event with a payload-free diagnostic. | Both getters drop the event, never throw, log no payload; the next event goes. |
| R05 | Both native modules send `expiresAt` (wall-clock ms, the 1.5 s deadline) with each request; one JS answer path skips `handleDeepLink` or `onForegroundNotification` for an expired request. The native fallback is unchanged. | An expired request isn't routed; a live one is. |
| Gap | Root `jest.d.ts` added for typed `@kirora/react-native/jest` imports. | Strict typecheck of an import through it. |

Verified: TypeScript build and typecheck, `npm test` (30 passing), `npm pack` (45 files),
Android bridge compiled with Gradle against React Native 0.81.4 and 0.88.0 and the local
`com.kirora:android-sdk:0.1.0`, Swift typecheck in Swift 5 and 6 modes against the
kirora-ios sources. Still unverified: Xcode iOS build, host-app builds, devices and push.
The `UNLICENSED` licence and the compatibility matrix are product decisions, left as is.

