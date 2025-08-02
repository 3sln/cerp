const UPDATE_TARGET = Symbol('UPDATE_TARGET');
const CONNECTED_INSTANCES = Symbol('CONNECTED');
const TARGET = Symbol('TARGET');
const ATTRIBUTE_OBSERVER = Symbol('ATTRIBUTE_OBSERVER');
const OBSERVED_ATTRIBUTES_SET = Symbol('OBSERVED_ATTRIBUTES_SET');
const DO_DISCONNECT = Symbol('DO_DISCONNECT');

function setsNotEqual(a, b) {
  if (a.size !== b.size) {
    return true;
  }

  for (const x of a.values()) {
    if (!b.has(x)) {
      return true;
    }
  }

  return false;
}

function updateTarget(newTarget) {
  const oldTarget = this[TARGET];
  const newObservedAttributes = this[OBSERVED_ATTRIBUTES_SET] = new Set(newTarget.observedAttributes);
  this[TARGET] = newTarget;

  if (!this[ATTRIBUTE_OBSERVER]) {
    const oldObservedAttributes = new Set(oldTarget.observedAttributes);

    if (setsNotEqual(oldObservedAttributes, newObservedAttributes)) {
      const attributeObserver = this[ATTRIBUTE_OBSERVER] = new window.MutationObserver(records => {
        for (const {attributeName, oldValue, target} of records) {
          if (this[OBSERVED_ATTRIBUTES_SET]?.has(attributeName)) {
            this[TARGET].prototype.attributeChangedCallback?.call(
              target,
              attributeName,
              oldValue,
              target.getAttribute(attributeName)
            );
          }
        }
      });
      for (const instance of this[CONNECTED_INSTANCES].values()) {
        attributeObserver.observe(instance, {attributes: true, attributeOldValue: true});
      }
    }
  }

  const instances = [...this[CONNECTED_INSTANCES].values()];

  const disconnectedCallback = oldTarget.prototype.disconnectedCallback;
  if (disconnectedCallback) {
    for (const instance of instances) {
      disconnectedCallback.call(instance);
    }
  }

  Object.setPrototypeOf(this.prototype, newTarget.prototype);

  const connectedCallback = newTarget.prototype.connectedCallback;
  if (connectedCallback) {
    for (const instance of instances) {
      connectedCallback.call(instance);
    }
  }
}

function wrapConstructor(constructor, options) {
  const hotReload = options?.hotReload ?? false;
  const delayDisconnect = options?.delayDisconnect ?? true;
  const className = constructor.name ?? 'Wrapper';

  if (hotReload && delayDisconnect) {
    return ({[className]: class Wrapper extends constructor {
      static [CONNECTED_INSTANCES] = new Set();
      static [TARGET] = constructor;
      static [UPDATE_TARGET] = updateTarget;

      static get observedAttributes() {
        return Wrapper[TARGET].observedAttributes;
      }

      static get formAssociated() {
        return Wrapper[TARGET].formAssociated;
      }

      #disconnectTimeout;
      #connectedDocument;
      isConnected = false;

      connectedCallback() {
        if (this.isConnected) {
          if (this.#disconnectTimeout) {
            clearTimeout(this.#disconnectTimeout);
            this.#disconnectTimeout = undefined;
          }

          if (this.#connectedDocument === super.ownerDocument) {
            Wrapper[TARGET].prototype.connectedMoveCallback?.call(this);
            return;
          }

          this[DO_DISCONNECT]();
        }

        Wrapper[CONNECTED_INSTANCES].add(this);
        this.isConnected = true;
        this.#connectedDocument = super.ownerDocument;
        Wrapper[ATTRIBUTE_OBSERVER]?.observe(this, {attributeFilter: Wrapper[TARGET].observedAttributes ?? []})
        Wrapper[TARGET].prototype.connectedCallback?.call(this);
      }

      disconnectedCallback() {
        if (this.#disconnectTimeout || !this.isConnected) {
          return;
        }

        this.#disconnectTimeout = setTimeout(() => {
          if (super.isConnected) {
            return;
          }
          this[DO_DISCONNECT]();
        });
      }

      connectedMoveCallback() {
        Wrapper[TARGET].prototype.connectedMoveCallback?.call(this);
      }

      adoptedCallback() {
        Wrapper[TARGET].prototype.adoptedCallback?.call(this);
      }

      attributeChangedCallback() {
        if (!Wrapper[ATTRIBUTE_OBSERVER]) {
          Wrapper[TARGET].prototype.attributeChangedCallback?.call(this, ...arguments);
        }
      }

      [DO_DISCONNECT]() {
        if (this.#disconnectTimeout) {
          clearTimeout(this.#disconnectTimeout);
          this.#disconnectTimeout = undefined;
        }

        Wrapper[CONNECTED_INSTANCES].delete(this);
        this.isConnected = false;
        this.#connectedDocument = undefined;
        Wrapper[TARGET].prototype.disconnectedCallback?.call(this);
      }
    }})[className];
  }

  if (hotReload) {
    return ({[className]: class Wrapper extends constructor {
      static [CONNECTED_INSTANCES] = new Set();
      static [TARGET] = constructor;
      static [UPDATE_TARGET] = updateTarget;

      static get observedAttributes() {
        return Wrapper[TARGET].observedAttributes;
      }

      static get formAssociated() {
        return Wrapper[TARGET].formAssociated;
      }

      connectedCallback() {
        Wrapper[CONNECTED_INSTANCES].add(this);
        Wrapper[ATTRIBUTE_OBSERVER]?.observe(this, {attributeFilter: Wrapper[TARGET].observedAttributes ?? []})
        Wrapper[TARGET].prototype.connectedCallback?.call(this);
      }

      disconnectedCallback() {
        this[DO_DISCONNECT]();
      }

      connectedMoveCallback() {
        Wrapper[TARGET].prototype.connectedMoveCallback?.call(this);
      }

      adoptedCallback() {
        Wrapper[TARGET].prototype.adoptedCallback?.call(this);
      }

      attributeChangedCallback() {
        if (!Wrapper[ATTRIBUTE_OBSERVER]) {
          Wrapper[TARGET].prototype.attributeChangedCallback?.call(this, ...arguments);
        }
      }

      [DO_DISCONNECT]() {
        Wrapper[CONNECTED_INSTANCES].delete(this);
        Wrapper[TARGET].prototype.disconnectedCallback?.call(this);
      }
    }})[className];
  }

  if (delayDisconnect) {
    return ({[className]: class Wrapper extends constructor {
      static [TARGET] = constructor;

      static get observedAttributes() {
        return Wrapper[TARGET].observedAttributes;
      }

      static get formAssociated() {
        return Wrapper[TARGET].formAssociated;
      }

      #disconnectTimeout;
      #connectedDocument;
      isConnected = false;

      connectedCallback() {
        if (this.isConnected) {
          if (this.#disconnectTimeout) {
            clearTimeout(this.#disconnectTimeout);
            this.#disconnectTimeout = undefined;
          }


          if (this.#connectedDocument === super.ownerDocument) {
            Wrapper[TARGET].prototype.connectedMoveCallback?.call(this);
            return;
          } 

          this[DO_DISCONNECT]();
        }

        this.isConnected = true;
        this.#connectedDocument = super.ownerDocument;
        Wrapper[TARGET].prototype.connectedCallback?.call(this);
      }

      disconnectedCallback() {
        if (this.#disconnectTimeout || !this.isConnected) {
          return;
        }

        this.#disconnectTimeout = setTimeout(() => {
          if (super.isConnected) {
            return;
          }
          this[DO_DISCONNECT]();
        });
      }

      connectedMoveCallback() {
        Wrapper[TARGET].prototype.connectedMoveCallback?.call(this);
      }

      adoptedCallback() {
        Wrapper[TARGET].prototype.adoptedCallback?.call(this);
      }

      attributeChangedCallback() {
        Wrapper[TARGET].prototype.attributeChangedCallback?.call(this, ...arguments);
      }

      [DO_DISCONNECT]() {
        if (this.#disconnectTimeout) {
          clearTimeout(this.#disconnectTimeout);
          this.#disconnectTimeout = undefined;
        }

        this.isConnected = false;
        this.#connectedDocument = undefined;
        Wrapper[TARGET].prototype.disconnectedCallback?.call(this);
      }
    }})[className];
  }

  return constructor;
}

export default (originalCustomElementRegistry, proxyOptions) => {
  const newDefineFn = function define(name, constructor, options) {
    const existingConstructor = originalCustomElementRegistry.get(name);
    if (existingConstructor) {
      existingConstructor[UPDATE_TARGET]?.(constructor);
    } else {
      const wrapped = wrapConstructor(constructor, proxyOptions);
      originalCustomElementRegistry.define(name, wrapped, options);
    }
  };

  const newGetFn = function get(name) {
    const registeredConstructor = originalCustomElementRegistry.get(name);
    return registeredConstructor?.[TARGET] ?? registeredConstructor;
  }

  return new Proxy(originalCustomElementRegistry, {
    get(_target, prop, _receiver) {
      switch(prop) {
        case 'define':
          return newDefineFn;
        case 'get':
          return newGetFn;
        default:
          return Reflect.get(...arguments);
      }
    }
  });
};
