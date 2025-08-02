import { expect, test, mock, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import cerp from "./index.js";

async function settle(window) {
  await window.happyDOM.whenAsyncComplete();
}

async function testHotReload(window) {
  class XExample1 extends window.HTMLElement {
    static observedAttributes = ['foo', 'bar'];
  };
  Object.assign(XExample1.prototype, {
    attributeChangedCallback: mock(() => {}),
    connectedCallback: mock(() => {}),
    disconnectedCallback: mock(() => {}),
    myCustomProperty: mock(() => {}),
  });

  window.customElements.define('x-example', XExample1);
  await settle(window);

  const instance = window.document.createElement('x-example');
  window.document.body.appendChild(instance);
  instance.setAttribute('foo', 'foo-val-1');
  instance.setAttribute('bar', 'bar-val-1');
  instance.setAttribute('baz', 'baz-val-1');
  instance.myCustomProperty();
  await settle(window);

  class XExample2 extends window.HTMLElement {
    static observedAttributes = ['foo', 'baz'];
  };
  Object.assign(XExample2.prototype, {
    attributeChangedCallback: mock(() => {}),
    connectedCallback: mock(() => {}),
    disconnectedCallback: mock(() => {}),
    myCustomProperty: mock(() => {}),
  });

  window.customElements.define('x-example', XExample2);
  await settle(window);
  instance.setAttribute('foo', 'foo-val-2');
  instance.setAttribute('bar', 'bar-val-2');
  instance.setAttribute('baz', 'baz-val-2');
  instance.myCustomProperty();
  await settle(window)
  instance.remove();

  await window.happyDOM.close();

  expect(XExample1.prototype.attributeChangedCallback.mock.calls).toEqual([
    ["foo", null, "foo-val-1"],
    ["bar", null, "bar-val-1"]
  ]);
  expect(XExample1.prototype.connectedCallback.mock.calls).toEqual([
    []
  ]);
  expect(XExample1.prototype.disconnectedCallback.mock.calls).toEqual([
    []
  ]);
  expect(XExample1.prototype.myCustomProperty).toHaveBeenCalledTimes(1);

  expect(XExample2.prototype.attributeChangedCallback.mock.calls).toEqual([
    ["foo", "foo-val-1", "foo-val-2"],
    ["baz", "baz-val-1", "baz-val-2"]
  ]);
  expect(XExample2.prototype.connectedCallback.mock.calls).toEqual([
    []
  ]);
  expect(XExample2.prototype.disconnectedCallback.mock.calls).toEqual([
    []
  ]);
  expect(XExample2.prototype.myCustomProperty).toHaveBeenCalledTimes(1);
}

async function testDelayDisconnect(window) {
  class XExample extends window.HTMLElement {
  };
  Object.assign(XExample.prototype, {
    connectedCallback: mock(() => {}),
    connectedMoveCallback: mock(() => {}),
    disconnectedCallback: mock(() => {})
  });

  window.customElements.define('x-example', XExample);
  await settle(window);

  const instance = window.document.createElement('x-example');
  window.document.body.appendChild(instance);
  await settle(window);

  expect(XExample.prototype.connectedCallback).toHaveBeenCalledTimes(1);

  const div = window.document.createElement('div');
  window.document.body.insertBefore(div, instance);
  await settle(window);

  window.document.body.insertBefore(instance, div);
  await settle(window);

  expect(XExample.prototype.connectedMoveCallback).toHaveBeenCalledTimes(1);

  div.appendChild(instance);
  await settle(window);

  expect(XExample.prototype.connectedMoveCallback).toHaveBeenCalledTimes(2);

  instance.remove();
  await settle(window);

  expect(XExample.prototype.connectedCallback).toHaveBeenCalledTimes(1);
  expect(XExample.prototype.disconnectedCallback).toHaveBeenCalledTimes(1);
}

test("hot reload only", async () => {
  const window = globalThis.window = new Window();
  window.customElements = cerp(window.customElements, {hotReload: true, delayDisconnect: false});
  await testHotReload(window);
});

test("delay disconnect only", async () => {
  const window = globalThis.window = new Window();
  window.customElements = cerp(window.customElements, {delayDisconnect: true, hotReload: false});
  await testDelayDisconnect(window);
});

test("delay disconnect and hot reload", async () => {
  {
    const window = globalThis.window = new Window();
    window.customElements = cerp(window.customElements, {delayDisconnect: true, hotReload: true});
    await testHotReload(window);
  }
  {
    const window = globalThis.window = new Window();
    window.customElements = cerp(window.customElements, {delayDisconnect: true, hotReload: true});
    await testDelayDisconnect(window);
  }
});
