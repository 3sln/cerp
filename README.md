# cerp
> Custom Element Registry Proxy

Wrap the custom element registry to enhance DevX and adjust custom element
behaviors.

```javascript
import cerp from '@3sln/cerp';

window.customElements = cerp(window.customElements, {
  hotReload: true, // enable hot reload, this is off by default
  delayDisconnect: true, // enable delay disconnect, this is on by default
});
```

## `hotReload`
Enabling hot reload allows custom elements to be re-defined on the fly
via HMR or other hot code reloading mechanisms.  This works by substituting
the given Custom Element constructor for a wrapper whose prototype chain
can be updated to swap in the new implementation.

```javascript
// define the original implementation
window.customElements.define('x-example', class XExample {
  ...
});

// update the implementation
window.customElements.define('x-example', class XExample {
  ...
});
```

Any element instances that are connected to document when the update occurs,
will get their `disconnectedCallback` called before the update, and the
new implementation's `connectedCallback` called after.

### Caveats
- Significant performance impact, this is intended only for development,
  make sure to turn it off for production
- Hot reloading `observedAttributes` is hacky, and will only work well for
  elements that are connected to a document
- Hot reloading `formAssociated` is not viable

## `delayDisconnect`
Enabling this option makes the lifecycle callbacks a little more forgiving
for things like moving custom elements from one place to another.  The given
implementation is wrapped in one that intercepts calls to `disconnectedCallback`.

The wrapper defers passing this call along to the user's implementation, skipping
it and the following call to `connectedCallback` if the element is reconnected
immediately.  If defined, the `connectedMoveCallback` will be called when this
optimization is triggerd.
