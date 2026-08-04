# Migration

## 0.1.0 — definitions are descriptors

cerp no longer replaces `window.customElements`, and no longer takes a class.
You build your own registry, and define elements from a plain object.

```javascript
// before
import cerp from 'cerp';

Object.defineProperty(window, 'customElements', {
  value: cerp(window.customElements, {hotReload: true, delayDisconnect: true}),
});

class MyElement extends HTMLElement {
  static observedAttributes = ['value'];

  constructor() {
    super();
    this.attachShadow({mode: 'open'});
  }

  connectedCallback() {
    window.addEventListener('resize', this.onResize);
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this.onResize);
  }

  attributeChangedCallback(name, oldValue, value) {
    this.render();
  }

  render() { ... }
}

customElements.define('my-element', MyElement);
```

```javascript
// after
import cerp from '@3sln/cerp';

const reg = cerp({hotReload: true, delayDisconnect: true});

reg.define('my-element', {
  attrs: ['value'],
  shadow: {mode: 'open'},

  proto: {
    render() { ... },
  },

  connected(signal) {
    window.addEventListener('resize', () => this.render(), {signal});
  },

  attr(name, oldValue, value, namespace) {
    this.render();
  },
});
```

### What moved where

| before                                       | after                          |
| -------------------------------------------- | ------------------------------ |
| `cerp(customElements, options)` + `defineProperty` | `cerp(options)`           |
| `class X extends HTMLElement`                | a descriptor object            |
| `constructor()`                              | `init(signal)`                 |
| `connectedCallback()`                        | `connected(signal)`            |
| `disconnectedCallback()`                     | `disconnected()`               |
| `adoptedCallback()`                          | `adopted()`                    |
| `connectedMoveCallback()`                    | `moved()`                      |
| `attributeChangedCallback()`                 | `attr(name, old, value, ns)`   |
| `static observedAttributes`                  | `attrs: [...]`                 |
| `static formAssociated`                      | `formAssociated: true`         |
| methods, getters and setters on the class    | `proto: {...}`                 |
| `this.attachShadow(...)` in the constructor  | `shadow: {...}`                |
| `this.attachInternals()` in the constructor  | `internals: true`              |
| `customElements.define('x', Class)` again    | `handle.update(descriptor)`    |

`this` is still the element everywhere, so method bodies move across unchanged.

### Mechanical rules

1. **The registry is yours now.** `cerp()` takes only options and returns a
   registry of its own. Nothing is installed over `window.customElements`, so
   delete the `Object.defineProperty` call. Elsewhere in your code
   `customElements.get`, `whenDefined`, `upgrade` and `getName` go on working —
   they were never really working before, since a Web IDL brand check does not
   see through a `Proxy`.

2. **The class body splits in two.** Lifecycle callbacks become top-level hooks
   with shorter names; everything else — methods, getters, setters — goes into
   `proto`. Both keep `this`.

3. **`constructor` becomes `init`, and stops calling `super()`.** Anything
   before `super()` has nowhere to go, because there is no longer a constructor
   of yours for the browser to call. Field initialisers become assignments in
   `init`.

4. **Teardown moves to signals.** Every hook that can run more than once is
   handed an `AbortSignal` aborted before its replacement runs, so a matching
   `removeEventListener` in `disconnected` is no longer needed — pass
   `{signal}` instead. For anything without a signal option, listen for
   `abort`.

5. **`attr` takes a fourth argument.** The browser has always passed the
   attribute namespace to `attributeChangedCallback`; the old wrapper forwarded
   it in one code path and dropped it in another. Both paths pass it now.

### Hot reloading changed shape

`init` runs **once per instance** and is never re-run. Live instances get
`reload(previous, signal)` when a definition is patched — that is the hook to
reconcile in. This is deliberate: `attachShadow` and `attachInternals` both
throw on a second call, so a re-runnable constructor could not have done the
one thing constructors are mostly used for.

New instances created after a reload run the **new** `init`. Under the old
wrapper they ran the original constructor for the life of the page, whatever
the reload said, because `class Wrapper extends YourClass` fixed `super()` at
definition time and nothing could swap it.

### Things that were quietly wrong before

Worth re-reading your components for these, since the old behaviour may have
been worked around:

- **`element.isConnected` was overwritten.** The wrapper defined an own,
  enumerable, writable `isConnected` on every instance, shadowing the native
  one — it appeared in `Object.keys(element)` and `JSON.stringify(element)`,
  and read `true` for a removed element until the delayed disconnect ran. It is
  now untouched and always means what the DOM says.
- **Redefining silently did nothing** without `hotReload`, where the browser
  would have thrown. It now throws.
- **`formAssociated` lied.** Adding it in a reload reported `true` while
  `attachInternals().form` threw, because the browser reads it once. Changing
  it now warns.
- **Attribute callbacks dropped and duplicated values.** After the first
  reload they came from a `MutationObserver` that read the element instead of
  the record, so two changes in one task both reported the last value; the
  `oldValue` was `null` for anything connected after the observer was made;
  detached elements stopped reporting entirely; and namespaced attributes
  reported the wrong value. All fixed, and both modes now agree.
