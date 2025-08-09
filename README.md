# cerp
> Custom Element Registry Proxy

A a small library that wraps the browser's native `CustomElementRegistry` with
a `Proxy`. It adds two powerful features that simplify developing with custom
elements, especially in modern JavaScript environments and frameworks.

### Features

#### Custom Element Hot Reloading 🔄

By default, the browser throws an error if you try to redefine a custom element
that's already in the registry. This is a common problem during development
when using hot module replacement (HMR).

`cerp`'s **`hotReload`** option solves this. When enabled, instead of throwing,
it **hot patches** the existing custom element's implementation. It properly
manages the lifecycle by calling the `disconnectedCallback` of the old
implementation and the `connectedCallback` of the new one for any existing
instances of the element, allowing for state and DOM reconciliation. This
feature is designed for development and should be disabled in production builds
due to its performance overhead.

#### Disconnect Callback Delaying ⏳

Web components' `connectedCallback` and `disconnectedCallback` are called every
time an element is moved in the DOM. This can be a performance bottleneck,
particularly in virtual DOM (vDOM) frameworks where nodes are frequently moved
during reconciliation.

The **`delayDisconnect`** option mitigates this by delaying the
`disconnectedCallback` with a `setTimeout`. If the element is reconnected to
the DOM before the timeout completes, the disconnect and reconnect callbacks
are canceled. This results in the element behaving as if it was never
disconnected. In these cases, if the custom element has a
`connectedMoveCallback` method, it will be called in place of the
`disconnectedCallback`/`connectedCallback` duo. This is a standard callback
that was introduced with the `moveBefore` API and is called whenever an element
is moved.

This feature is enabled by default as its performance benefits are generally
desirable in most use cases.

### Usage

`cerp` works by creating a new `Proxy` for the `customElements` registry. You
pass it the original `customElements` object and a configuration object.

```javascript
import cerp from 'cerp';

// The main use case is to replace the global customElements registry with the proxy.
const customElements = cerp(window.customElements, {
  // Enables hot reloading (disabled by default)
  hotReload: true,
  
  // Enables delayed disconnects (enabled by default)
  delayDisconnect: true
});

// Now, use this proxied registry just like you would the original.
customElements.define('my-element', MyElement);
```

To integrate with your build system, you can use environment variables to
toggle the `hotReload` option:

```javascript
const customElements = cerp(window.customElements, {
  hotReload: process.env.NODE_ENV === 'development',
});
```
