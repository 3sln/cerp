# cerp

> Custom Element Reloadable Prototypes

A small library for defining custom elements from a plain descriptor instead of
a class, so a definition can be patched in place while the page is running —
constructor included.

```javascript
// x-counter.js
import cerp from '@3sln/cerp';

const reg = cerp({hotReload: import.meta.env.DEV});

export const definition = {
  attrs: ['count'],
  shadow: {mode: 'open'},

  proto: {
    get count() {
      return Number(this.getAttribute('count') ?? 0);
    },
    render() {
      this.shadowRoot.textContent = `count: ${this.count}`;
    },
  },

  init() {
    this.render();
  },

  connected(signal) {
    this.addEventListener('click', () => this.setAttribute('count', this.count + 1), {signal});
  },

  attr() {
    this.render();
  },

  reload() {
    this.render();
  },
};

const counter = reg.define('x-counter', definition);

if (import.meta.hot) {
  import.meta.hot.accept(module => counter.update(module.definition));
}
```

Edit `render` and save: every `<x-counter>` on the page redraws, keeping its
shadow root, its count and its click listener. Edit `init` and the next one
constructed runs the new version.

### Why a descriptor and not a class

The browser reads a custom element's constructor, `observedAttributes` and
`formAssociated` once, when the name is defined, and never looks at them again.
A name can be defined once per registry and never taken back.

So a library that hands the browser *your* class can never replace your
constructor. It can swap a prototype underneath the instances that already
exist, but every instance created after that still runs the constructor from
whichever version of the module happened to load first — a shadow root built
there, fields initialised there, a subscription opened there, all frozen at the
first version for the life of the page.

cerp hands the browser a class of its own, once, and keeps your implementation
on a prototype it can rewrite. The constructor the browser holds is a fixed
shim that calls into the current descriptor, so `init` is genuinely replaceable.

It also means cerp never touches `window.customElements`. It registers through
it like any other caller, so `whenDefined`, `upgrade`, `getName` and everything
else keep working.

### The registry

```javascript
const reg = cerp({
  // Patch definitions in place when a name is defined twice. Off by default:
  // it costs an instance registry and a MutationObserver per element, and
  // moves attribute callbacks off the browser's synchronous reaction queue.
  hotReload: false,

  // Hold `disconnected` back by a task so a reordering move does not read as
  // a disconnection. On by default.
  delayDisconnect: true,

  // The realm to define in. Defaults to the current global, and to that
  // realm's own registry — pass either to define into an iframe.
  window: globalThis,
  registry: undefined,

  warn: message => console.warn(`cerp: ${message}`),
});
```

`reg.define(name, descriptor)` returns a handle: `{name, Element, update}`.
`update(descriptor)` re-patches the definition and reads better from an HMR
callback than a second `define` does. Both do the same thing. With `hotReload`
off, redefining a name throws rather than silently doing nothing.

`reg.get(name)` returns the descriptor currently in force, or `undefined` if
this registry did not define the name.

### The descriptor

| field                                   | when it applies                                         |
| --------------------------------------- | ------------------------------------------------------- |
| `proto`                                 | reconciled on every define                              |
| `attrs`                                 | reconciled on every define (fixed without `hotReload`)  |
| `init(signal)`                          | once per instance, in the constructor                   |
| `reload(previous, signal)`              | on every live instance when the definition is patched   |
| `connected(signal)`                     | on connection, and again after a reload                 |
| `disconnected()`                        | on disconnection                                        |
| `moved()`                               | on a move, native or emulated                           |
| `adopted()`                             | on adoption into another document                       |
| `attr(name, oldValue, value, namespace)`| on a change to an observed attribute                    |
| `extends`                               | fixed at first define                                   |
| `shadow`                                | fixed at first define                                   |
| `internals`                             | fixed at first define                                   |
| `formAssociated`                        | fixed at first define                                   |

`this` is the element in every hook and every `proto` member.

`extends` names a built-in tag, for a customized built-in — `{extends: 'button'}`
is created as `document.createElement('button', {is: 'x-name'})`. Safari does
not implement customized built-ins at all.

`shadow` takes the options `attachShadow` takes; the root is attached before
`init` runs, so `this.shadowRoot` is already there. `internals: true` attaches
`ElementInternals`, reachable as `element[internals]` using the exported symbol.
Both throw on a second call, which is why cerp owns them and neither can be
reloaded.

`proto` holds getters, setters and methods, and is merged by property
descriptor — an accessor stays an accessor and is not invoked while copying. A
member dropped from the descriptor is deleted from the prototype; a member that
did not change keeps its identity. Names the browser reserves for reactions
(`connectedCallback` and friends) are refused with a warning, since cerp
defines those itself and yours would never be called.

One caution: do not build a descriptor by spreading a previous one. Spread
*reads* the source, so a `proto` getter would run against a plain object and
either throw or land as a frozen value. Hand `update` a whole descriptor — which
is what a reloaded module gives you anyway.

### Hot reloading

`init` runs **once per instance**, in the constructor, and is never re-run.
When a definition is patched, live instances get `reload(previous, signal)`
instead — that is where a new version reconciles whatever the old one left
behind. New instances created afterwards run the new `init` normally.

Teardown is by `AbortSignal`, not by a cleanup hook. Every hook that can run
more than once is handed a signal that is aborted before its replacement runs,
so anything registered against it unwinds by itself:

```javascript
connected(signal) {
  window.addEventListener('resize', () => this.render(), {signal});

  const observer = new ResizeObserver(() => this.render());
  observer.observe(this);
  signal.addEventListener('abort', () => observer.disconnect());
}
```

There are two scopes, each also reachable from `proto` members as a
symbol-keyed property:

- **`signal`** — the connection. Aborted when the element disconnects, and
  replaced on reload just before `connected` runs again. `element[signal]`.
- **`instanceSignal`** — the instance. Aborted and replaced when the definition
  reloads, just before `reload` runs. `element[instanceSignal]`.

```javascript
import cerp, {signal, instanceSignal, internals} from '@3sln/cerp';

// inside a proto method
this[signal].addEventListener('abort', () => subscription.close());
```

A reload re-runs `connected` for anything currently connected. That is not
ceremony: a listener registered as `this.onClick.bind(this)` captured the old
method, and no amount of prototype reconciliation reaches inside a bound
function.

Because `delayDisconnect` treats a reordering move as no disconnection at all,
a moved element keeps its connection signal — listeners survive reordering
rather than being torn down and rebuilt on every move.

### What cannot be hot reloaded

`extends`, `shadow`, `internals` and `formAssociated` are fixed when the
browser first defines the name. Changing one in a later descriptor warns and
does nothing until the page is reloaded — the alternative is a library that
reports `formAssociated: true` while `attachInternals().form` throws.

`attrs` is the exception: with `hotReload` on it can be widened or narrowed
freely, and an attribute that becomes observed is backfilled with the value it
already holds, the way the browser does at upgrade. That works because in
hot reload mode attribute changes come from a `MutationObserver` rather than
from the browser's reaction queue, which makes them **asynchronous**. With
`hotReload` off they come from the reaction queue and are synchronous, and
`attrs` is fixed at define. Both paths report the same four arguments.

### Development

```
bun install
bun run test
```

The suite runs in headless Chromium through
[`@web/test-runner`](https://modern-web.dev/docs/test-runner/overview/), not
against a DOM emulation. cerp is built entirely out of one specific piece of
browser machinery and almost nothing it does means anything away from it:
whether a definition may be replaced, when the browser snapshots
`observedAttributes` and `formAssociated`, whether `attributeChangedCallback`
fires synchronously and with how many arguments, and what order the custom
element reaction queue drains a move in are the behaviours under test. An
emulator supplies its own answers to those.

Each test takes a fresh realm from `createRealm()` in `test-helpers.js` — an
iframe, and so an empty `CustomElementRegistry`, since a custom element name can
be defined once per registry and never taken back.

`bun run test:watch` reruns on change, `bun run test:coverage` reports coverage.
