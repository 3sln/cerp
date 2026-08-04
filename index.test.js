import {createRealm, expect, mock, settle, test} from './test-helpers.js';
import cerp, {instanceSignal, internals, signal} from './index.js';

/**
 * A registry bound to a fresh realm, plus the warnings it emitted.
 *
 * Warnings are collected rather than printed because several of them are the
 * behaviour under test — a frozen field that changed has nothing to show for
 * itself except the warning.
 */
function setup(options = {}) {
  const realm = createRealm();
  const warnings = [];
  const reg = cerp({
    window: realm.window,
    warn: message => warnings.push(message),
    ...options,
  });
  return {...realm, reg, warnings};
}

// --- Prototype reconciliation ---------------------------------------------

test('members reach instances that already exist', async () => {
  const {document, reg} = setup({hotReload: true});
  const handle = reg.define('x-el', {proto: {greet: () => 'v1'}});

  const el = document.createElement('x-el');
  document.body.appendChild(el);
  expect(el.greet()).toBe('v1');

  handle.update({proto: {greet: () => 'v2'}});
  expect(el.greet()).toBe('v2');
});

test('members removed from the descriptor are removed from the prototype', async () => {
  const {document, reg} = setup({hotReload: true});
  const handle = reg.define('x-el', {proto: {gone: () => 1, kept: () => 1}});
  const el = document.createElement('x-el');

  handle.update({proto: {kept: () => 2}});
  expect(el.gone).toBeUndefined();
  expect(el.kept()).toBe(2);
});

test('accessors survive as accessors and are not invoked while copying', async () => {
  const {document, reg} = setup({hotReload: true});
  const reads = mock(() => 'value');
  reg.define('x-el', {
    proto: {
      get thing() {
        return reads();
      },
      set thing(v) {
        this.assigned = v;
      },
    },
  });

  // Object.assign would have read it once, here, and frozen the result.
  expect(reads).toHaveBeenCalledTimes(0);

  const el = document.createElement('x-el');
  expect(el.thing).toBe('value');
  expect(reads).toHaveBeenCalledTimes(1);
  el.thing = 'written';
  expect(el.assigned).toBe('written');
});

test('an unchanged member keeps its identity across a reload', async () => {
  const {document, reg} = setup({hotReload: true});
  const stable = () => 'same';
  const handle = reg.define('x-el', {proto: {stable, other: () => 1}});
  const el = document.createElement('x-el');
  const before = el.stable;

  handle.update({proto: {stable, other: () => 2}});
  expect(el.stable).toBe(before);
  expect(el.other()).toBe(2);
});

test('a proto entry named after a reaction is refused', async () => {
  const {reg, warnings} = setup({hotReload: true});
  const shadowed = mock(() => {});
  reg.define('x-el', {proto: {connectedCallback: shadowed}});

  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain('connectedCallback');
});

// --- init, reload and signals ---------------------------------------------

test('init runs once per instance and never again', async () => {
  const {document, reg} = setup({hotReload: true});
  const init = mock(() => {});
  const reload = mock(() => {});
  const handle = reg.define('x-el', {init, reload});

  const el = document.createElement('x-el');
  document.body.appendChild(el);
  await settle();
  expect(init).toHaveBeenCalledTimes(1);

  handle.update({init, reload});
  expect(init).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(1);

  // A new instance runs the *current* init — the thing a wrapped class could
  // never do, since its constructor was fixed at definition time.
  document.body.appendChild(document.createElement('x-el'));
  await settle();
  expect(init).toHaveBeenCalledTimes(2);
});

test('reload receives the previous descriptor', async () => {
  const {document, reg} = setup({hotReload: true});
  const first = {version: 1, reload: mock(() => {})};
  const handle = reg.define('x-el', first);
  document.body.appendChild(document.createElement('x-el'));

  const seen = mock(() => {});
  handle.update({version: 2, reload(previous) {
    seen(previous.version);
  }});
  expect(seen.mock.calls).toEqual([[1]]);
});

test('the init signal aborts on reload, taking its listeners with it', async () => {
  const {window, document, reg} = setup({hotReload: true});
  const heard = mock(() => {});
  const handle = reg.define('x-el', {
    init(abort) {
      window.addEventListener('ping', heard, {signal: abort});
    },
  });

  const el = document.createElement('x-el');
  document.body.appendChild(el);
  window.dispatchEvent(new window.Event('ping'));
  expect(heard).toHaveBeenCalledTimes(1);

  // The replacement registers nothing, so if the old listener survived the
  // reload it would still be heard.
  handle.update({reload() {}});
  window.dispatchEvent(new window.Event('ping'));
  expect(heard).toHaveBeenCalledTimes(1);
  expect(el[instanceSignal].aborted).toBe(false);
});

test('the connected signal aborts on disconnection', async () => {
  const {window, document, reg} = setup();
  const heard = mock(() => {});
  reg.define('x-el', {
    connected(abort) {
      window.addEventListener('ping', heard, {signal: abort});
    },
  });

  const el = document.createElement('x-el');
  document.body.appendChild(el);
  const connectionSignal = el[signal];
  window.dispatchEvent(new window.Event('ping'));
  expect(heard).toHaveBeenCalledTimes(1);

  el.remove();
  await settle();
  expect(connectionSignal.aborted).toBe(true);
  window.dispatchEvent(new window.Event('ping'));
  expect(heard).toHaveBeenCalledTimes(1);
});

test('a move keeps the connected signal alive', async () => {
  const {document, reg} = setup();
  reg.define('x-el', {connected: mock(() => {}), moved: mock(() => {})});

  const el = document.createElement('x-el');
  const host = document.createElement('div');
  document.body.append(el, host);
  await settle();

  const connectionSignal = el[signal];
  host.appendChild(el);
  await settle();

  expect(connectionSignal.aborted).toBe(false);
  expect(el[signal]).toBe(connectionSignal);
});

test('reload re-runs connected so bound listeners are rebound', async () => {
  const {document, reg} = setup({hotReload: true});
  const v1 = mock(() => {});
  const v2 = mock(() => {});
  const handle = reg.define('x-el', {
    proto: {handle: v1},
    connected(abort) {
      this.addEventListener('poke', this.handle.bind(this), {signal: abort});
    },
  });

  const el = document.createElement('x-el');
  document.body.appendChild(el);
  el.dispatchEvent(new (el.ownerDocument.defaultView.Event)('poke'));
  expect(v1).toHaveBeenCalledTimes(1);

  handle.update({
    proto: {handle: v2},
    connected(abort) {
      this.addEventListener('poke', this.handle.bind(this), {signal: abort});
    },
  });
  el.dispatchEvent(new (el.ownerDocument.defaultView.Event)('poke'));
  expect(v1).toHaveBeenCalledTimes(1);
  expect(v2).toHaveBeenCalledTimes(1);
});

test('a disconnected instance is reloaded but not reconnected', async () => {
  const {document, reg} = setup({hotReload: true});
  const handle = reg.define('x-el', {});
  const el = document.createElement('x-el');

  const reload = mock(() => {});
  const connected = mock(() => {});
  handle.update({reload, connected});
  expect(reload).toHaveBeenCalledTimes(1);
  expect(connected).toHaveBeenCalledTimes(0);
});

// --- delayDisconnect ------------------------------------------------------

test('reordering reads as a move, removal as a disconnection', async () => {
  const {document, reg} = setup();
  const connected = mock(() => {});
  const moved = mock(() => {});
  const disconnected = mock(() => {});
  reg.define('x-el', {connected, moved, disconnected});

  const el = document.createElement('x-el');
  document.body.appendChild(el);
  await settle();
  expect(connected).toHaveBeenCalledTimes(1);

  const div = document.createElement('div');
  document.body.insertBefore(div, el);
  await settle();

  document.body.insertBefore(el, div);
  await settle();
  expect(moved).toHaveBeenCalledTimes(1);

  div.appendChild(el);
  await settle();
  expect(moved).toHaveBeenCalledTimes(2);

  el.remove();
  await settle();
  expect(connected).toHaveBeenCalledTimes(1);
  expect(disconnected).toHaveBeenCalledTimes(1);
});

test('without delayDisconnect a move is a disconnection', async () => {
  const {document, reg} = setup({delayDisconnect: false});
  const connected = mock(() => {});
  const disconnected = mock(() => {});
  reg.define('x-el', {connected, disconnected});

  const el = document.createElement('x-el');
  const host = document.createElement('div');
  document.body.append(el, host);
  await settle();

  host.appendChild(el);
  await settle();
  expect(connected).toHaveBeenCalledTimes(2);
  expect(disconnected).toHaveBeenCalledTimes(1);
});

test('a native moveBefore reports as a move', async () => {
  const {document, reg} = setup();
  const connected = mock(() => {});
  const moved = mock(() => {});
  const disconnected = mock(() => {});
  reg.define('x-el', {connected, moved, disconnected});

  const from = document.createElement('div');
  const to = document.createElement('div');
  document.body.append(from, to);
  const el = document.createElement('x-el');
  from.appendChild(el);
  await settle();

  to.moveBefore(el, null);
  await settle();

  expect(connected).toHaveBeenCalledTimes(1);
  expect(moved).toHaveBeenCalledTimes(1);
  expect(disconnected).toHaveBeenCalledTimes(0);
});

test('adoption into another document disconnects and reconnects', async () => {
  const {document, reg} = setup();
  const other = createRealm();
  const connected = mock(() => {});
  const adopted = mock(() => {});
  const disconnected = mock(() => {});
  const moved = mock(() => {});
  reg.define('x-el', {connected, adopted, disconnected, moved});

  const el = document.createElement('x-el');
  document.body.appendChild(el);
  await settle();

  other.document.body.appendChild(el);
  await settle();

  expect(adopted).toHaveBeenCalledTimes(1);
  // A new document is not a move, however much it arrives looking like one.
  expect(moved).toHaveBeenCalledTimes(0);
  expect(disconnected).toHaveBeenCalledTimes(1);
  expect(connected).toHaveBeenCalledTimes(2);
});

test('isConnected is left alone', async () => {
  const {document, reg} = setup();
  reg.define('x-el', {});
  const el = document.createElement('x-el');

  expect(Object.getOwnPropertyDescriptor(el, 'isConnected')).toBeUndefined();
  expect(Object.keys(el)).toEqual([]);
  expect(el.isConnected).toBe(false);

  document.body.appendChild(el);
  expect(el.isConnected).toBe(true);
  el.remove();
  expect(el.isConnected).toBe(false);
});

// --- Attributes -----------------------------------------------------------

for (const hotReload of [false, true]) {
  const mode = hotReload ? 'observed' : 'native';

  test(`${mode}: attr reports name, old, new and namespace`, async () => {
    const {document, reg} = setup({hotReload});
    const attr = mock(() => {});
    reg.define('x-el', {attrs: ['foo'], attr});

    const el = document.createElement('x-el');
    document.body.appendChild(el);
    el.setAttribute('foo', 'one');
    el.setAttribute('bar', 'ignored');
    await settle();
    el.setAttribute('foo', 'two');
    await settle();

    expect(attr.mock.calls).toEqual([
      ['foo', null, 'one', null],
      ['foo', 'one', 'two', null],
    ]);
  });

  test(`${mode}: a detached element still reports`, async () => {
    const {document, reg} = setup({hotReload});
    const attr = mock(() => {});
    reg.define('x-el', {attrs: ['foo'], attr});

    const el = document.createElement('x-el');
    el.setAttribute('foo', 'one');
    await settle();
    expect(attr.mock.calls).toEqual([['foo', null, 'one', null]]);
  });

  test(`${mode}: two changes in one task are two calls`, async () => {
    const {document, reg} = setup({hotReload});
    const attr = mock(() => {});
    reg.define('x-el', {attrs: ['foo'], attr});

    const el = document.createElement('x-el');
    document.body.appendChild(el);
    el.setAttribute('foo', 'one');
    el.setAttribute('foo', 'two');
    await settle();

    expect(attr.mock.calls).toEqual([
      ['foo', null, 'one', null],
      ['foo', 'one', 'two', null],
    ]);
  });

  test(`${mode}: a namespaced attribute reports its own value`, async () => {
    const {document, reg} = setup({hotReload});
    const attr = mock(() => {});
    reg.define('x-el', {attrs: ['foo'], attr});

    const el = document.createElement('x-el');
    document.body.appendChild(el);
    el.setAttribute('foo', 'plain');
    await settle();
    el.setAttributeNS('http://example.com/ns', 'foo', 'namespaced');
    await settle();

    expect(attr.mock.calls).toEqual([
      ['foo', null, 'plain', null],
      ['foo', null, 'namespaced', 'http://example.com/ns'],
    ]);
  });
}

test('a reload may widen the observed set', async () => {
  const {document, reg} = setup({hotReload: true});
  const handle = reg.define('x-el', {attrs: ['foo'], attr: mock(() => {})});

  const el = document.createElement('x-el');
  document.body.appendChild(el);
  await settle();

  const attr = mock(() => {});
  handle.update({attrs: ['foo', 'bar'], attr});
  el.setAttribute('bar', 'now-observed');
  await settle();
  expect(attr.mock.calls).toEqual([['bar', null, 'now-observed', null]]);
});

test('a newly observed attribute is backfilled with what it already holds', async () => {
  const {document, reg} = setup({hotReload: true});
  const handle = reg.define('x-el', {attrs: ['foo'], attr: mock(() => {})});

  const el = document.createElement('x-el');
  el.setAttribute('bar', 'already-here');
  document.body.appendChild(el);
  await settle();

  const attr = mock(() => {});
  handle.update({attrs: ['foo', 'bar'], attr});
  expect(attr.mock.calls).toEqual([['bar', null, 'already-here', null]]);
});

test('a reload may narrow the observed set', async () => {
  const {document, reg} = setup({hotReload: true});
  const handle = reg.define('x-el', {attrs: ['foo', 'bar'], attr: mock(() => {})});
  const el = document.createElement('x-el');
  document.body.appendChild(el);

  const attr = mock(() => {});
  handle.update({attrs: ['foo'], attr});
  el.setAttribute('bar', 'no-longer-observed');
  el.setAttribute('foo', 'still-observed');
  await settle();
  expect(attr.mock.calls).toEqual([['foo', null, 'still-observed', null]]);
});

// --- Frozen fields --------------------------------------------------------

test('a shadow root is attached once, from the descriptor', async () => {
  const {document, reg} = setup({hotReload: true});
  const handle = reg.define('x-el', {shadow: {mode: 'open'}});

  const el = document.createElement('x-el');
  expect(el.shadowRoot).toBeTruthy();
  const root = el.shadowRoot;

  // Re-attaching would throw, which is exactly why cerp owns it.
  handle.update({shadow: {mode: 'open'}});
  expect(el.shadowRoot).toBe(root);
});

test('element internals come from the descriptor', async () => {
  const {document, reg} = setup();
  reg.define('x-el', {internals: true, formAssociated: true});

  const el = document.createElement('x-el');
  const form = document.createElement('form');
  form.appendChild(el);
  document.body.appendChild(form);
  expect(el[internals].form).toBe(form);
});

test('changing a frozen field warns instead of pretending', async () => {
  const {reg, warnings} = setup({hotReload: true});
  const handle = reg.define('x-el', {shadow: {mode: 'open'}, formAssociated: false});

  handle.update({shadow: {mode: 'closed'}, formAssociated: true});
  expect(warnings.length).toBe(2);
  expect(warnings[0]).toContain('shadow');
  expect(warnings[1]).toContain('formAssociated');
});

test('a frozen field rebuilt with the same contents is not a change', async () => {
  const {reg, warnings} = setup({hotReload: true});
  const handle = reg.define('x-el', {shadow: {mode: 'open'}, attrs: ['a']});

  handle.update({shadow: {mode: 'open'}, attrs: ['a', 'b']});
  expect(warnings).toEqual([]);
});

// --- Registry behaviour ---------------------------------------------------

test('redefining without hotReload throws rather than doing nothing', async () => {
  const {reg} = setup();
  reg.define('x-el', {});
  expect(() => reg.define('x-el', {})).toThrow(/already defined/);
});

test('the native registry is left intact', async () => {
  const {window, reg} = setup();
  const handle = reg.define('x-el', {});

  // The failure this replaces: proxying the registry broke every method that
  // was not overridden, because a brand check does not see through a Proxy.
  expect(window.customElements.get('x-el')).toBe(handle.Element);
  expect(window.customElements.getName(handle.Element)).toBe('x-el');
  expect(() => window.customElements.upgrade(window.document.body)).not.toThrow();
  await window.customElements.whenDefined('x-el');
});

test('customized built-ins', async () => {
  const {document, reg} = setup();
  const connected = mock(() => {});
  reg.define('x-button', {extends: 'button', connected, proto: {shout: () => 'oi'}});

  const el = document.createElement('button', {is: 'x-button'});
  document.body.appendChild(el);
  await settle();

  expect(el).toBeInstanceOf(document.defaultView.HTMLButtonElement);
  expect(connected).toHaveBeenCalledTimes(1);
  expect(el.shout()).toBe('oi');
});

test('formAssociated on a customized built-in warns', async () => {
  const {reg, warnings} = setup();
  reg.define('x-button', {extends: 'button', formAssociated: true});
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain('formAssociated');
});

test('get returns the descriptor in force', async () => {
  const {reg} = setup({hotReload: true});
  const first = {attrs: ['a']};
  const second = {attrs: ['b']};
  const handle = reg.define('x-el', first);
  expect(reg.get('x-el')).toBe(first);
  handle.update(second);
  expect(reg.get('x-el')).toBe(second);
  expect(reg.get('x-nothing')).toBeUndefined();
});

test('the README example works, and hot reloads', async () => {
  const {document, reg} = setup({hotReload: true});

  const counter = reg.define('x-counter', {
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
    connected(abort) {
      this.addEventListener('click', () => this.setAttribute('count', this.count + 1), {
        signal: abort,
      });
    },
    attr() {
      this.render();
    },
  });

  const el = document.createElement('x-counter');
  document.body.appendChild(el);
  await settle();
  expect(el.shadowRoot.textContent).toBe('count: 0');

  el.click();
  await settle();
  expect(el.shadowRoot.textContent).toBe('count: 1');

  // A reloaded module hands over a whole descriptor, so that is what this is.
  // Note that it is written out rather than spread over the previous one:
  // spreading *reads* the source, which would run `get count` against a plain
  // object and throw. The same reason cerp merges `proto` by descriptor.
  counter.update({
    attrs: ['count'],
    shadow: {mode: 'open'},
    proto: {
      get count() {
        return Number(this.getAttribute('count') ?? 0);
      },
      render() {
        this.shadowRoot.textContent = `clicked ${this.count} times`;
      },
    },
    init() {
      this.render();
    },
    connected(abort) {
      this.addEventListener('click', () => this.setAttribute('count', this.count + 1), {
        signal: abort,
      });
    },
    attr() {
      this.render();
    },
    reload() {
      this.render();
    },
  });
  expect(el.shadowRoot.textContent).toBe('clicked 1 times');

  el.click();
  await settle();
  expect(el.shadowRoot.textContent).toBe('clicked 2 times');
});

test('two registries in one realm do not see each other', async () => {
  const realm = createRealm();
  const a = cerp({window: realm.window, hotReload: true});
  const b = cerp({window: realm.window, hotReload: true});
  a.define('x-a', {});
  expect(b.get('x-a')).toBeUndefined();
  // The underlying registry is shared, so the collision is the browser's to
  // report rather than something cerp can paper over.
  expect(() => b.define('x-a', {})).toThrow();
});
