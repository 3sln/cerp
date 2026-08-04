/**
 * Test support for a real browser.
 *
 * Tests run under @web/test-runner in headless Chromium. Three things are
 * needed that the browser does not hand over by itself:
 *
 *   - a fresh realm per test. A custom element name can be defined once per
 *     registry and never taken back, so a suite about redefinition needs a new
 *     registry for every test. `createRealm()` gives one out of an iframe: a
 *     real document with a real `CustomElementRegistry`, a real reaction queue
 *     and a real `Node.prototype`.
 *   - a way to wait for work the browser does off the current task, since
 *     `disconnectedCallback` is delayed behind a timer and observed attribute
 *     changes arrive on a microtask. `settle()` is that wait.
 *   - the small assertion vocabulary the suite already speaks. It is nine
 *     matchers wide and delegates to chai, so failure messages stay useful.
 *     Keeping the dialect meant the move to a browser could be read as what it
 *     is — a change of environment — rather than as a rewrite of every
 *     assertion in the project.
 */

import {expect as chaiExpect} from 'chai';

export const describe = globalThis.describe;
export const test = globalThis.it;
export const beforeEach = globalThis.beforeEach;
export const afterEach = globalThis.afterEach;

// --- Realms ---------------------------------------------------------------

const realms = new Set();

/**
 * A fresh browsing context, standing in for what a DOM emulator's `new Window()`
 * used to provide. Its `customElements` is untouched, so each test starts from
 * an empty registry and may define `x-example` as if for the first time.
 */
export function createRealm() {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:300px;height:300px;border:0;position:absolute;top:0;left:0';
  document.body.appendChild(frame);
  realms.add(frame);
  return {window: frame.contentWindow, document: frame.contentDocument};
}

export function destroyRealms() {
  for (const frame of realms) frame.remove();
  realms.clear();
}

// Realms are torn down after every test whether or not the test made one, so no
// file has to remember to.
globalThis.afterEach(destroyRealms);

/**
 * Install a cerp proxy over a realm's registry, the way the README says to.
 *
 * `Window.customElements` is a plain readonly attribute, so assigning to it
 * throws in a module's strict mode and silently does nothing outside one.
 * Replacing it takes `defineProperty`, and a suite that reached for the
 * registry any other way would not be testing how the library is actually
 * installed.
 */
export function installCerp(realm, cerp, options) {
  const proxy = cerp(realm.window.customElements, options);
  Object.defineProperty(realm.window, 'customElements', {
    value: proxy,
    configurable: true,
  });
  return proxy;
}

/**
 * Let the browser finish what it has queued.
 *
 * A macrotask, which drains the microtask queue on the way — so this covers
 * both the `setTimeout` that `delayDisconnect` hides the disconnect behind and
 * the microtask a `MutationObserver` delivers attribute records on. Timers
 * already queued at zero delay run before this one, since they are served in
 * the order they were set.
 */
export function settle() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// --- Spies ----------------------------------------------------------------

export function mock(implementation) {
  const calls = [];
  const fn = function (...args) {
    calls.push(args);
    return implementation?.apply(this, args);
  };
  fn.mock = {calls};
  return fn;
}

// --- Assertions -----------------------------------------------------------

function callCountOf(spy) {
  if (!spy?.mock) throw new Error('expected a mock() function');
  return spy.mock.calls.length;
}

function matchers(actual, negated) {
  const assert = negated ? chaiExpect(actual).to.not : chaiExpect(actual).to;
  const count = () =>
    negated ? chaiExpect(callCountOf(actual)).to.not : chaiExpect(callCountOf(actual)).to;

  return {
    toBe: expected => assert.equal(expected),
    toEqual: expected => assert.eql(expected),
    toBeUndefined: () => assert.equal(undefined),
    toBeTruthy: () => (negated ? chaiExpect(!!actual).to.be.false : chaiExpect(!!actual).to.be.true),
    toBeInstanceOf: expected => assert.be.instanceOf(expected),
    toContain: expected => assert.contain(expected),
    toThrow: expected => (expected === undefined ? assert.throw() : assert.throw(expected)),
    toHaveBeenCalled: () => count().be.greaterThan(0),
    toHaveBeenCalledTimes: times => count().equal(times),
  };
}

export function expect(actual) {
  return {...matchers(actual, false), not: matchers(actual, true)};
}
