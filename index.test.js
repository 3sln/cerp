import {createRealm, expect, installCerp, mock, settle, test} from './test-helpers.js';
import cerp from './index.js';

async function testHotReload(realm) {
  const {window, document} = realm;

  class XExample1 extends window.HTMLElement {
    static observedAttributes = ['foo', 'bar'];
  }
  Object.assign(XExample1.prototype, {
    attributeChangedCallback: mock(() => {}),
    connectedCallback: mock(() => {}),
    disconnectedCallback: mock(() => {}),
    myCustomProperty: mock(() => {}),
  });

  window.customElements.define('x-example', XExample1);
  await settle();

  const instance = document.createElement('x-example');
  document.body.appendChild(instance);
  instance.setAttribute('foo', 'foo-val-1');
  instance.setAttribute('bar', 'bar-val-1');
  instance.setAttribute('baz', 'baz-val-1');
  instance.myCustomProperty();
  await settle();

  class XExample2 extends window.HTMLElement {
    static observedAttributes = ['foo', 'baz'];
  }
  Object.assign(XExample2.prototype, {
    attributeChangedCallback: mock(() => {}),
    connectedCallback: mock(() => {}),
    disconnectedCallback: mock(() => {}),
    myCustomProperty: mock(() => {}),
  });

  window.customElements.define('x-example', XExample2);
  await settle();
  instance.setAttribute('foo', 'foo-val-2');
  instance.setAttribute('bar', 'bar-val-2');
  instance.setAttribute('baz', 'baz-val-2');
  instance.myCustomProperty();
  await settle();
  instance.remove();
  await settle();

  // Four arguments, not three: the browser's own reaction passes the attribute
  // namespace as well, and the wrapper forwards `arguments` whole. A DOM
  // emulator used to pass three here, which is the sort of thing this suite
  // moved into a browser to stop guessing about.
  expect(XExample1.prototype.attributeChangedCallback.mock.calls).toEqual([
    ['foo', null, 'foo-val-1', null],
    ['bar', null, 'bar-val-1', null],
  ]);
  expect(XExample1.prototype.connectedCallback.mock.calls).toEqual([[]]);
  expect(XExample1.prototype.disconnectedCallback.mock.calls).toEqual([[]]);
  expect(XExample1.prototype.myCustomProperty).toHaveBeenCalledTimes(1);

  // Three, because once the observed attributes change these come from a
  // `MutationObserver` rather than from the browser's reaction queue, and that
  // path synthesises the call itself. The arity shift between the two is real
  // and is recorded here rather than smoothed over.
  expect(XExample2.prototype.attributeChangedCallback.mock.calls).toEqual([
    ['foo', 'foo-val-1', 'foo-val-2'],
    ['baz', 'baz-val-1', 'baz-val-2'],
  ]);
  expect(XExample2.prototype.connectedCallback.mock.calls).toEqual([[]]);
  expect(XExample2.prototype.disconnectedCallback.mock.calls).toEqual([[]]);
  expect(XExample2.prototype.myCustomProperty).toHaveBeenCalledTimes(1);
}

async function testDelayDisconnect(realm) {
  const {window, document} = realm;

  class XExample extends window.HTMLElement {}
  Object.assign(XExample.prototype, {
    connectedCallback: mock(() => {}),
    connectedMoveCallback: mock(() => {}),
    disconnectedCallback: mock(() => {}),
  });

  window.customElements.define('x-example', XExample);
  await settle();

  const instance = document.createElement('x-example');
  document.body.appendChild(instance);
  await settle();

  expect(XExample.prototype.connectedCallback).toHaveBeenCalledTimes(1);

  const div = document.createElement('div');
  document.body.insertBefore(div, instance);
  await settle();

  document.body.insertBefore(instance, div);
  await settle();

  expect(XExample.prototype.connectedMoveCallback).toHaveBeenCalledTimes(1);

  div.appendChild(instance);
  await settle();

  expect(XExample.prototype.connectedMoveCallback).toHaveBeenCalledTimes(2);

  instance.remove();
  await settle();

  expect(XExample.prototype.connectedCallback).toHaveBeenCalledTimes(1);
  expect(XExample.prototype.disconnectedCallback).toHaveBeenCalledTimes(1);
}

test('hot reload only', async () => {
  const realm = createRealm();
  installCerp(realm, cerp, {hotReload: true, delayDisconnect: false});
  await testHotReload(realm);
});

test('delay disconnect only', async () => {
  const realm = createRealm();
  installCerp(realm, cerp, {delayDisconnect: true, hotReload: false});
  await testDelayDisconnect(realm);
});

test('delay disconnect and hot reload', async () => {
  {
    const realm = createRealm();
    installCerp(realm, cerp, {delayDisconnect: true, hotReload: true});
    await testHotReload(realm);
  }
  {
    const realm = createRealm();
    installCerp(realm, cerp, {delayDisconnect: true, hotReload: true});
    await testDelayDisconnect(realm);
  }
});
