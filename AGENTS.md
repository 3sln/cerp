# cerp Agent Guidelines

This document outlines guidelines for LLM agents interacting with the `cerp` project.

## 1. Architecture Overview

- **Releasing:** Bumping `version` in `package.json` on `main` opens a draft release (`.github/workflows/draft-release.yml`). Publishing that draft creates the tag and publishes to npm (`.github/workflows/publish.yml`), after re-running the tests and checking the tag matches `package.json`. Nothing is tagged or published by a version bump alone. Requires an `NPM_TOKEN` repository secret with publish rights on the `@3sln` scope.
- **Registry Factory:** The main export is a factory, `cerp(options)`, in `index.js`. It returns a registry object — `{define, get}` — closed over a config. Several registries may exist in one realm; they do not see each other, but they all define into the same underlying `CustomElementRegistry`, so two of them claiming one tag name is the browser's error to raise.
- **Definitions Are Descriptors, Not Classes:** `reg.define(name, descriptor)` takes a plain object. The author never writes a class and never writes a constructor. This is the whole design, not a stylistic preference — see §3.
- **Nothing Is Installed Globally:** cerp registers through `window.customElements` like any other caller. It must never replace, wrap or proxy it. The previous version did, and a Web IDL brand check does not see through a `Proxy`: `upgrade` and `getName` threw `Illegal invocation`, and `whenDefined` returned a promise that always rejected, silently. Do not reintroduce a proxy.
- **Symbol Exports:** `signal`, `instanceSignal` and `internals` are exported symbols used as keys on elements. They are the public way to reach per-element state from a `proto` member. `STATE` is module-private and is not exported.

## 2. General Principles (For All Agents)

- **Adhere to Conventions:** Before making changes, analyze existing code, tests, and documentation to understand and follow established patterns.
- **Mimic Style:** Match the existing coding style, including formatting, naming, and comment density. Comments here explain *why* a thing is the way it is, usually by naming the browser behaviour that forced it. Keep that.
- **Test Your Changes:** All modifications to the library must be accompanied by tests. The suite covers 100% of statements in `index.js`; do not let that slide.
- **Tests Run In A Real Browser:** `bun run test` drives the suite through `@web/test-runner` in headless Chromium (`bun run test:coverage` for coverage). Essentially nothing cerp does means anything away from a real browser — whether a definition may be replaced, when `observedAttributes` and `formAssociated` are snapshotted, whether `attributeChangedCallback` is synchronous and how many arguments it carries, what order the reaction queue drains a move in, whether `connectedMoveCallback` exists. It cost a wrong assertion to learn: the DOM emulator passed three arguments to `attributeChangedCallback` where every browser passes four, and the suite had encoded the emulator's answer. Do not reintroduce an emulator.
- **A Realm Per Test:** `createRealm()` in `test-helpers.js` hands out an iframe, and therefore an empty `CustomElementRegistry`. This is not tidiness — a custom element name can be defined once per registry and never taken back, so a suite about redefinition has no other way to run twice. `cerp({window})` is pointed at the same realm the elements are created in. Realms are torn down after every test automatically.
- **The Assertion Vocabulary Is Deliberate:** `test-helpers.js` exposes nine matchers over chai. It exists so the move to a browser could be read as a change of environment rather than a rewrite of every assertion in the project. Add a matcher when a test needs one; do not convert the suite to a different dialect for its own sake.
- **Verify Browser Claims, Do Not Recall Them:** Much of this library is a response to a specific browser behaviour. If you are about to assert one, write a throwaway test and run it. Several of the defects this library was rewritten to fix came from plausible assumptions about what the DOM does.

---

## 3. For Contributors (Agents Modifying `cerp`)

This section applies when you are modifying the `cerp` library itself.

### The Constraint Everything Follows From

The browser reads a custom element's constructor, `observedAttributes` and `formAssociated` **exactly once**, when the name is defined, and never consults them again. Verified: a `static get observedAttributes()` is called once no matter how many attributes change afterwards.

Three consequences run through the whole file:

- **One class per tag, exactly.** A tag can be defined once per registry, so the class cerp registers can never be replaced. And a constructor cannot be reused for a second tag — `define` throws `NotSupportedError: this constructor has already been used with this registry` — so there can be no shared base class registered for every definition. `createClass()` therefore mints a fresh pair of classes on **every** `define()`. Hoisting them to module scope looks like an obvious optimisation and breaks on the second element defined.
- **The registered class must be a fixed shim.** Since it can never be replaced, every one of its methods indirects through `definition.descriptor`, which is the mutable part. That indirection is where hot reloading actually lives. Do not inline a descriptor hook into the class body, however much cheaper it looks — it would freeze that hook at the first definition, which is the exact bug the rewrite existed to fix.
- **Some fields can never be hot reloaded.** `extends`, `shadow`, `internals` and `formAssociated` are fixed at first define. Changing one warns. Do not "fix" this with a forwarding getter: the previous version had one, and it reported `formAssociated: true` while `attachInternals().form` threw, which is worse than the warning.

### Two Prototypes, On Purpose

`createClass()` builds `Members` and then the registered class extending it. The author's `proto` members go on `Members.prototype`; cerp's reactions go on the registered prototype above it. Two reasons, both load-bearing:

- Reconciliation gets an object whose own keys are **exactly** the author's members, so removing one is a `delete` rather than a diff against everything an element inherits.
- A `proto` entry named `connectedCallback` cannot clobber cerp's. It is shadowed and refused with a warning instead.

Do not collapse these into one prototype.

### Merge By Descriptor, Never By Assignment

`reconcileMembers()` uses `Object.getOwnPropertyDescriptors` and `Object.defineProperty`. `Object.assign` and object spread **read** the source, so a getter would run once during the copy and land as whatever value it happened to return. This is not theoretical — it was hit while writing the README example, where spreading a previous descriptor ran `get count` against a plain object and threw. The same caution is documented for users in `README.md`.

Members that did not change are left alone rather than redefined, so anything holding a reference to one keeps holding the same function.

### One Attribute Path Per Mode, Chosen At Construction

- **`hotReload` off:** `observedAttributes` carries `attrs`, and callbacks come from the browser's reaction queue. Synchronous, four arguments, correct `oldValue`, and they fire on detached elements.
- **`hotReload` on:** `observedAttributes` is `[]` and a `MutationObserver` per element stands in, because the observed set has to stay open and the browser's is frozen.

The previous version switched between these two mid-session, and that switch is where most of its defects lived. **Never switch paths at runtime.** The mode is fixed when the registry is constructed.

The observer path has four details that are each a fixed bug; do not simplify them away:

- **One observer per element, not one per definition.** `MutationObserver` has no way to stop observing a single node — only `disconnect()`, which drops them all. An observer only its own element refers to falls out of memory with it. A shared one keeps every element it ever saw alive.
- **Observe from the constructor**, so detached elements report. The old code observed on connect, and elements that were never connected silently stopped reporting.
- **`{attributes: true, attributeOldValue: true}`, never `attributeFilter`.** A filter is snapshotted at `observe()` time and goes stale the moment a reload widens `attrs`. Filter at delivery, against `definition.observed`.
- **Derive the new value from the following record**, not by reading the element. A record carries only the value *before* its mutation, so reading the element reports whatever it finally settled on — two changes in one task collapsing onto the last. Use `getAttributeNS` with the record's namespace for the final one.

Attributes are backfilled when a reload widens the observed set, matching what the browser does at upgrade.

### Lifecycle Invariants

- **`init` runs once per instance, in the constructor, and is never re-run.** Live instances get `reload(previous, signal)` instead. This is not an oversight to be helpfully corrected: `attachShadow` and `attachInternals` both throw on a second call, so a re-runnable `init` would break on the first thing most components do.
- **Teardown is by `AbortSignal`, not by a cleanup hook.** Every hook that can run more than once is handed a signal aborted before its replacement runs. Do not add a `destroy` hook; the contract is that a hook cleans up after its own previous invocation by having been given a signal that is now aborted.
- **A reload re-runs `connected` for anything currently connected.** Required, not ceremony: a listener registered as `this.onClick.bind(this)` captured the old method, and prototype reconciliation cannot reach inside a bound function.
- **`delayDisconnect` must never define `isConnected` on an instance.** The previous version did, as an own enumerable writable property shadowing the native accessor — it appeared in `Object.keys(element)` and `JSON.stringify(element)` and read `true` for a removed element. State lives in the `STATE` symbol.
- **Instances are tracked weakly, and only when `hotReload` is on.** `live()` prunes dead `WeakRef`s as it iterates. Production pays for none of it.

---

## 4. For Users (Agents Using `cerp` To Define Elements)

This section applies when you are writing components with cerp, not modifying it.

### Shape Of A Definition

```javascript
import cerp from '@3sln/cerp';

const reg = cerp({hotReload: import.meta.env.DEV});

export const definition = {
  attrs: ['value'],
  shadow: {mode: 'open'},
  proto: {
    get value() { return this.getAttribute('value'); },
    render() { this.shadowRoot.textContent = this.value; },
  },
  init() { this.render(); },
  connected(signal) {
    this.addEventListener('input', () => this.render(), {signal});
  },
  attr() { this.render(); },
  reload() { this.render(); },
};

const handle = reg.define('x-field', definition);

if (import.meta.hot) {
  import.meta.hot.accept(module => handle.update(module.definition));
}
```

`this` is the element in every hook and every `proto` member.

### Best Practices

- **Put methods, getters and setters in `proto`; put lifecycle in the top level.** The split is what lets cerp tell the two apart.
- **Register listeners with the signal**, not with a matching `removeEventListener` in `disconnected`. `{signal}` on `addEventListener`, and `signal.addEventListener('abort', ...)` for anything else that needs unwinding.
- **Give `reload` a body if a redefinition needs to catch up.** It is usually one call to whatever renders. Without it a patched definition changes behaviour but does not redraw what is already on screen.
- **Never build a descriptor by spreading a previous one.** Spread reads the source and would run a `proto` getter against a plain object. Hand `update` a whole descriptor — which is what a reloaded module gives you anyway.
- **Do not name a `proto` member after a reaction** (`connectedCallback` and friends). cerp defines those and yours would never be called; it warns.
- **Leave `hotReload` off in production.** It costs an instance registry and a `MutationObserver` per element, and moves attribute callbacks off the browser's synchronous reaction queue onto a microtask.

### Things That Will Not Work

- **Changing `extends`, `shadow`, `internals` or `formAssociated` in a reload.** The browser fixed them at first define. cerp warns; reload the page.
- **Private fields.** `#x` needs a class body and there is not one. Use a symbol key, or an ordinary property.
- **`extends` in Safari.** Customized built-ins are not implemented there at all.
- **Two registries claiming one tag name.** Scoped registries are not yet available, so every registry defines into the same one and the second `define` throws.
