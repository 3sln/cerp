/**
 * cerp — hot patchable custom element definitions.
 *
 * A definition is a descriptor rather than a class, and that is the whole
 * point. The browser snapshots a custom element's constructor,
 * `observedAttributes` and `formAssociated` when the name is defined and never
 * consults them again, so a library that hands the browser the author's class
 * can never replace the author's constructor — new instances go on running the
 * implementation that was current when the page loaded. cerp hands the browser
 * a class of its own, once, and keeps the author's implementation on a
 * prototype it can rewrite in place. A reload changes what existing and new
 * instances do alike.
 *
 * Nothing here touches `window.customElements`. cerp registers through it like
 * any other caller, so `whenDefined`, `upgrade` and `getName` keep working.
 */

/** Connection-scoped `AbortSignal`. Aborted when the element disconnects. */
export const signal = Symbol('cerp.signal');

/** Instance-scoped `AbortSignal`. Aborted when the definition reloads. */
export const instanceSignal = Symbol('cerp.instanceSignal');

/** The `ElementInternals` attached by the `internals` descriptor field. */
export const internals = Symbol('cerp.internals');

const STATE = Symbol('cerp.state');

// cerp's own reactions live on the registered class, one prototype above the
// author's members, so a `proto` entry with one of these names is shadowed and
// silently does nothing. Say so rather than let it look wired up.
const RESERVED = new Set([
  'constructor',
  'connectedCallback',
  'disconnectedCallback',
  'adoptedCallback',
  'connectedMoveCallback',
  'attributeChangedCallback',
]);

// Read by the browser exactly once, when the name is first defined. A reload
// may change them in the descriptor and nothing will come of it, so changing
// one is worth saying out loud rather than leaving to be discovered.
const FROZEN = ['extends', 'shadow', 'internals', 'formAssociated'];

/**
 * @param {object} [options]
 * @param {boolean} [options.hotReload] Patch definitions in place when a name
 *   is defined twice. Off by default: it costs an instance registry and a
 *   `MutationObserver` per element, and moves attribute callbacks off the
 *   browser's synchronous reaction queue. Meant for development.
 * @param {boolean} [options.delayDisconnect] Hold `disconnected` back by a task
 *   so a reordering move does not read as a disconnection. On by default.
 * @param {Window} [options.window] The realm to define in.
 * @param {CustomElementRegistry} [options.registry] Defaults to the realm's.
 * @param {(message: string) => void} [options.warn]
 */
export default function cerp(options = {}) {
  const {
    hotReload = false,
    delayDisconnect = true,
    window = globalThis,
    registry = window.customElements,
    warn = message => console.warn(`cerp: ${message}`),
  } = options;

  const config = {hotReload, delayDisconnect, window, registry, warn};
  const definitions = new Map();

  return {
    /**
     * Define `name`, or patch it if it is already defined and `hotReload` is
     * on. Returns a handle whose `update` does the same thing, which reads
     * better from an HMR callback than a second `define` does.
     */
    define(name, descriptor) {
      const existing = definitions.get(name);
      if (existing) {
        update(existing, descriptor);
        return existing.handle;
      }
      const definition = create(config, name, descriptor);
      definitions.set(name, definition);
      return definition.handle;
    },

    /** The descriptor currently in force for `name`, if cerp defined it. */
    get(name) {
      return definitions.get(name)?.descriptor;
    },
  };
}

// --- Definitions ----------------------------------------------------------

function create(config, name, descriptor) {
  const definition = {
    config,
    name,
    descriptor,
    observed: new Set(descriptor.attrs ?? []),
    // Only needed in order to patch what is already on the page, so only paid
    // for when patching is possible. Held weakly: an element cerp cannot see
    // any more is not one anybody can reload.
    instances: config.hotReload ? new Set() : undefined,
    members: undefined,
    handle: undefined,
  };

  if (descriptor.extends && descriptor.formAssociated) {
    config.warn(
      `"${name}": \`formAssociated\` does not apply to a customized built-in; ` +
        'only autonomous custom elements can be form-associated.',
    );
  }

  const Element = createClass(definition);
  reconcileMembers(definition, undefined, descriptor.proto);
  config.registry.define(
    name,
    Element,
    descriptor.extends ? {extends: descriptor.extends} : undefined,
  );

  definition.handle = {name, Element, update: next => update(definition, next)};
  return definition;
}

function createClass(definition) {
  const {config, descriptor} = definition;
  const Base = descriptor.extends
    ? config.window.document.createElement(descriptor.extends).constructor
    : config.window.HTMLElement;

  // Two prototypes rather than one. The author's members go on the lower of
  // them, which gives reconciliation an object whose own keys are exactly the
  // author's members — so removing one is a `delete` rather than a diff against
  // everything an element inherits — and it puts cerp's own reactions out of
  // reach of a `proto` entry that happens to share a name with one.
  const Members = class extends Base {};
  definition.members = Members.prototype;

  return class extends Members {
    // Snapshotted by the browser here and now. With `hotReload` on the set has
    // to stay open, so nothing is declared and a `MutationObserver` per
    // instance stands in; see `observeAttributes`.
    static observedAttributes = config.hotReload ? [] : [...definition.observed];
    static formAssociated = descriptor.formAssociated ?? false;

    constructor() {
      super();
      construct(definition, this);
    }

    connectedCallback() {
      connect(definition, this);
    }

    disconnectedCallback() {
      disconnect(definition, this);
    }

    connectedMoveCallback() {
      definition.descriptor.moved?.call(this);
    }

    adoptedCallback() {
      definition.descriptor.adopted?.call(this);
    }

    attributeChangedCallback(name, oldValue, value, namespace) {
      definition.descriptor.attr?.call(this, name, oldValue, value, namespace);
    }
  };
}

// --- Instance lifecycle ---------------------------------------------------

function construct(definition, element) {
  const {config, descriptor} = definition;

  const state = {
    connected: false,
    connectedDocument: undefined,
    disconnectTimeout: undefined,
    connectedController: undefined,
    instanceController: undefined,
  };
  element[STATE] = state;

  // Both throw on a second call, so both are cerp's to make and neither can be
  // reloaded. An author who needs a closed root, or options cerp does not
  // model, can still attach one from `init` — it just cannot be re-attached.
  if (descriptor.shadow && !element.shadowRoot) element.attachShadow(descriptor.shadow);
  if (descriptor.internals) element[internals] = element.attachInternals();

  if (config.hotReload) {
    definition.instances.add(new WeakRef(element));
    observeAttributes(definition, element);
  }

  state.instanceController = new config.window.AbortController();
  element[instanceSignal] = state.instanceController.signal;
  descriptor.init?.call(element, state.instanceController.signal);
}

function connect(definition, element) {
  const {config, descriptor} = definition;
  const state = element[STATE];

  if (state.connected) {
    // Still logically connected, so the delayed disconnection has not run yet:
    // this is a move rather than a fresh connection.
    clearDisconnect(state);
    if (state.connectedDocument === element.ownerDocument) {
      descriptor.moved?.call(element);
      return;
    }
    // A different document is a real disconnection wearing a move's clothes.
    finishDisconnect(definition, element, state);
  }

  state.connected = true;
  state.connectedDocument = element.ownerDocument;
  state.connectedController = new config.window.AbortController();
  element[signal] = state.connectedController.signal;
  descriptor.connected?.call(element, state.connectedController.signal);
}

function disconnect(definition, element) {
  const {config} = definition;
  const state = element[STATE];
  if (!state.connected) return;

  if (!config.delayDisconnect) {
    finishDisconnect(definition, element, state);
    return;
  }
  if (state.disconnectTimeout !== undefined) return;

  // A task, not a microtask. Removing and reinserting a node is synchronous, so
  // anything that reads as a move has already happened by the time this runs.
  state.disconnectTimeout = config.window.setTimeout(() => {
    state.disconnectTimeout = undefined;
    if (element.isConnected) return;
    finishDisconnect(definition, element, state);
  });
}

function finishDisconnect(definition, element, state) {
  clearDisconnect(state);
  state.connected = false;
  state.connectedDocument = undefined;
  state.connectedController?.abort();
  state.connectedController = undefined;
  element[signal] = undefined;
  definition.descriptor.disconnected?.call(element);
}

function clearDisconnect(state) {
  if (state.disconnectTimeout === undefined) return;
  clearTimeout(state.disconnectTimeout);
  state.disconnectTimeout = undefined;
}

// --- Attributes -----------------------------------------------------------

/**
 * With `hotReload` on, the browser is told to observe nothing, because the set
 * it would observe is fixed at definition time and the entire point is that the
 * set can change. A `MutationObserver` per element stands in.
 *
 * Per element, rather than one per definition observing many, because a
 * `MutationObserver` offers no way to stop observing a single node — only
 * `disconnect()`, which drops them all. An observer that only its own element
 * refers to falls out of memory along with it.
 */
function observeAttributes(definition, element) {
  const observer = new definition.config.window.MutationObserver(records =>
    deliver(definition, element, records),
  );
  observer.observe(element, {attributes: true, attributeOldValue: true});
}

function deliver(definition, element, records) {
  const {attr} = definition.descriptor;
  if (!attr) return;

  // A record carries the value an attribute held *before* its mutation and
  // nothing about the value after, so reading the attribute now would report
  // whatever it finally settled on — every change in a batch collapsing onto
  // the last. Walking backwards, the value after a mutation is the value before
  // the next mutation of the same attribute, and only the final one has to be
  // read off the element.
  const calls = [];
  const following = new Map();

  for (let i = records.length - 1; i >= 0; i--) {
    const {attributeName: name, attributeNamespace: namespace, oldValue} = records[i];
    const key = `${namespace ?? ''} ${name}`;
    const value = following.has(key)
      ? following.get(key)
      : element.getAttributeNS(namespace, name);
    following.set(key, oldValue);
    if (definition.observed.has(name)) calls.push([name, oldValue, value, namespace]);
  }

  for (let i = calls.length - 1; i >= 0; i--) attr.apply(element, calls[i]);
}

/**
 * The browser delivers `attributeChangedCallback` for attributes an element
 * already carries when it is upgraded. A reload that starts observing an
 * attribute is that same event one step later, and is owed the same call.
 */
function backfill(definition, element, added) {
  const {attr} = definition.descriptor;
  if (!attr) return;
  for (const name of added) {
    if (!element.hasAttribute(name)) continue;
    attr.call(element, name, null, element.getAttribute(name), null);
  }
}

// --- Reloading ------------------------------------------------------------

function update(definition, next) {
  const {config, name} = definition;

  if (!config.hotReload) {
    throw new Error(
      `cerp: "${name}" is already defined and hotReload is off. Guard the ` +
        'redefinition behind `import.meta.hot`, or construct the registry ' +
        'with {hotReload: true}.',
    );
  }

  const previous = definition.descriptor;
  for (const key of FROZEN) {
    if (equal(previous[key], next[key])) continue;
    config.warn(
      `"${name}": \`${key}\` changed, but the browser fixed it when the ` +
        'element was first defined. Reload the page for it to take effect.',
    );
  }

  const wasObserved = definition.observed;
  definition.descriptor = next;
  definition.observed = new Set(next.attrs ?? []);
  reconcileMembers(definition, previous.proto, next.proto);

  const added = [...definition.observed].filter(attribute => !wasObserved.has(attribute));

  for (const element of live(definition)) {
    const state = element[STATE];

    // Both signals abort before anything of the new definition runs, so
    // whatever the old one registered against them is gone by the time its
    // replacement registers. This is the only teardown there is: a hook cleans
    // up after its own previous invocation by virtue of having been handed a
    // signal that is now aborted.
    state.instanceController?.abort();
    state.connectedController?.abort();

    // `init` is once per instance and stays that way — an instance that exists
    // has already been initialised, and `reload` is where a definition
    // reconciles whatever the previous one left behind.
    state.instanceController = new config.window.AbortController();
    element[instanceSignal] = state.instanceController.signal;
    next.reload?.call(element, previous, state.instanceController.signal);

    backfill(definition, element, added);

    // Re-run for anything currently connected, in the order a fresh connection
    // would see. It is not ceremony: a listener registered as
    // `this.onClick.bind(this)` captured the old method, and no amount of
    // prototype reconciliation reaches inside a bound function.
    if (state.connected) {
      state.connectedController = new config.window.AbortController();
      element[signal] = state.connectedController.signal;
      next.connected?.call(element, state.connectedController.signal);
    }
  }
}

function* live(definition) {
  for (const ref of definition.instances) {
    const element = ref.deref();
    if (element === undefined) definition.instances.delete(ref);
    else yield element;
  }
}

/**
 * Copy the author's members onto the prototype the instances already have.
 *
 * By descriptor, never by `Object.assign`: assign *reads* the source, so a
 * getter would run once during the copy and land as whatever it happened to
 * return that time. Members that did not change are left alone rather than
 * replaced, so anything holding a reference to one holds the same function.
 */
function reconcileMembers(definition, previous, next) {
  const target = definition.members;
  const before = previous ? Object.getOwnPropertyDescriptors(previous) : {};
  const after = next ? Object.getOwnPropertyDescriptors(next) : {};

  for (const key of Reflect.ownKeys(before)) {
    if (!Object.hasOwn(after, key)) delete target[key];
  }

  for (const key of Reflect.ownKeys(after)) {
    if (RESERVED.has(key)) {
      definition.config.warn(
        `"${definition.name}": \`proto.${String(key)}\` is cerp's to define, ` +
          'and would never be called. Use the descriptor hook for that job instead.',
      );
      continue;
    }
    if (Object.hasOwn(before, key) && sameMember(before[key], after[key])) continue;
    Object.defineProperty(target, key, after[key]);
  }
}

function sameMember(a, b) {
  return (
    a.value === b.value &&
    a.get === b.get &&
    a.set === b.set &&
    a.writable === b.writable &&
    a.enumerable === b.enumerable &&
    a.configurable === b.configurable
  );
}

/** Structural, so a descriptor rebuilt with the same contents reads as equal. */
function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
