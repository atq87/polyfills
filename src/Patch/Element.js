import * as Env from '../Environment.js';
import {Proxy as DocumentProxy} from '../Environment/Document.js';
import {default as EnvElement, Proxy as ElementProxy} from '../Environment/Element.js';
import CustomElementInternals from '../CustomElementInternals.js';
import CEState from '../CustomElementState.js';
import * as Utilities from '../Utilities.js';

import PatchParentNode from './Interface/ParentNode.js';
import PatchChildNode from './Interface/ChildNode.js';

/**
 * @param {!CustomElementInternals} internals
 */
export default function(internals) {
  if (EnvElement.attachShadow) {
    Utilities.setPropertyUnchecked(Element.prototype, 'attachShadow',
      /**
       * @this {Element}
       * @param {!{mode: string}} init
       * @return {ShadowRoot}
       */
      function(init) {
        const shadowRoot = ElementProxy.attachShadow(this, init);
        this.__CE_shadowRoot = shadowRoot;
        return shadowRoot;
      });
  } else {
    console.warn('Custom Elements: `Element#attachShadow` was not patched.');
  }


  function patch_innerHTML(destination, baseDescriptor) {
    Object.defineProperty(destination, 'innerHTML', {
      enumerable: baseDescriptor.enumerable,
      configurable: true,
      get: baseDescriptor.get,
      set: /** @this {Element} */ function(htmlString) {
        const isConnected = Utilities.isConnected(this);

        // NOTE: In IE11, when using the native `innerHTML` setter, all nodes
        // that were previously descendants of the context element have all of
        // their children removed as part of the set - the entire subtree is
        // 'disassembled'. This work around walks the subtree *before* using the
        // native setter.
        /** @type {!Array<!Element>|undefined} */
        let removedElements = undefined;
        if (isConnected) {
          removedElements = [];
          Utilities.walkDeepDescendantElements(this, element => {
            if (element !== this) {
              removedElements.push(element);
            }
          });
        }

        baseDescriptor.set.call(this, htmlString);

        if (removedElements) {
          for (let i = 0; i < removedElements.length; i++) {
            const element = removedElements[i];
            if (element.__CE_state === CEState.custom) {
              internals.disconnectedCallback(element);
            }
          }
        }

        // Only create custom elements if this element's owner document is
        // associated with the registry.
        if (!this.ownerDocument.__CE_hasRegistry) {
          internals.patchTree(this);
        } else {
          internals.patchAndUpgradeTree(this);
        }
        return htmlString;
      },
    });
  }

  if (EnvElement.innerHTML && EnvElement.innerHTML.get) {
    patch_innerHTML(Element.prototype, EnvElement.innerHTML);
  } else if (Env.HTMLElement.innerHTML && Env.HTMLElement.innerHTML.get) {
    patch_innerHTML(HTMLElement.prototype, Env.HTMLElement.innerHTML);
  } else {
    // In this case, `innerHTML` has no exposed getter but still exists. Rather
    // than using the environment proxy, we have to get and set it directly.

    /** @type {HTMLDivElement} */
    const rawDiv = DocumentProxy.createElement(document, 'div');

    internals.addPatch(function(element) {
      patch_innerHTML(element, {
        enumerable: true,
        configurable: true,
        // Implements getting `innerHTML` by performing an unpatched `cloneNode`
        // of the element and returning the resulting element's `innerHTML`.
        // TODO: Is this too expensive?
        get: /** @this {Element} */ function() {
          return Env.NodeProxy.cloneNode(this, true).innerHTML;
        },
        // Implements setting `innerHTML` by creating an unpatched element,
        // setting `innerHTML` of that element and replacing the target
        // element's children with those of the unpatched element.
        set: /** @this {Element} */ function(assignedValue) {
          // NOTE: re-route to `content` for `template` elements.
          // We need to do this because `template.appendChild` does not
          // route into `template.content`.
          /** @type {!Node} */
          const content =
            (ElementProxy.localName(this) === 'template')
            ? Env.HTMLTemplateElementProxy.content(/** @type {!HTMLTemplateElement} */ (this))
            : this;
          rawDiv.innerHTML = assignedValue;

          while (Env.NodeProxy.childNodes(content).length > 0) {
            Env.NodeProxy.removeChild(content, content.childNodes[0]);
          }
          while (Env.NodeProxy.childNodes(rawDiv).length > 0) {
            Env.NodeProxy.appendChild(content, rawDiv.childNodes[0]);
          }
        },
      });
    });
  }


  Utilities.setPropertyUnchecked(Element.prototype, 'setAttribute',
    /**
     * @this {Element}
     * @param {string} name
     * @param {string} newValue
     */
    function(name, newValue) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CEState.custom) {
        return ElementProxy.setAttribute(this, name, newValue);
      }

      const oldValue = ElementProxy.getAttribute(this, name);
      ElementProxy.setAttribute(this, name, newValue);
      newValue = ElementProxy.getAttribute(this, name);
      internals.attributeChangedCallback(this, name, oldValue, newValue, null);
    });

  Utilities.setPropertyUnchecked(Element.prototype, 'setAttributeNS',
    /**
     * @this {Element}
     * @param {?string} namespace
     * @param {string} name
     * @param {string} newValue
     */
    function(namespace, name, newValue) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CEState.custom) {
        return ElementProxy.setAttributeNS(this, namespace, name, newValue);
      }

      const oldValue = ElementProxy.getAttributeNS(this, namespace, name);
      ElementProxy.setAttributeNS(this, namespace, name, newValue);
      newValue = ElementProxy.getAttributeNS(this, namespace, name);
      internals.attributeChangedCallback(this, name, oldValue, newValue, namespace);
    });

  Utilities.setPropertyUnchecked(Element.prototype, 'removeAttribute',
    /**
     * @this {Element}
     * @param {string} name
     */
    function(name) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CEState.custom) {
        return ElementProxy.removeAttribute(this, name);
      }

      const oldValue = ElementProxy.getAttribute(this, name);
      ElementProxy.removeAttribute(this, name);
      if (oldValue !== null) {
        internals.attributeChangedCallback(this, name, oldValue, null, null);
      }
    });

  Utilities.setPropertyUnchecked(Element.prototype, 'removeAttributeNS',
    /**
     * @this {Element}
     * @param {?string} namespace
     * @param {string} name
     */
    function(namespace, name) {
      // Fast path for non-custom elements.
      if (this.__CE_state !== CEState.custom) {
        return ElementProxy.removeAttributeNS(this, namespace, name);
      }

      const oldValue = ElementProxy.getAttributeNS(this, namespace, name);
      ElementProxy.removeAttributeNS(this, namespace, name);
      // In older browsers, `Element#getAttributeNS` may return the empty string
      // instead of null if the attribute does not exist. For details, see;
      // https://developer.mozilla.org/en-US/docs/Web/API/Element/getAttributeNS#Notes
      const newValue = ElementProxy.getAttributeNS(this, namespace, name);
      if (oldValue !== newValue) {
        internals.attributeChangedCallback(this, name, oldValue, newValue, namespace);
      }
    });


  function patch_insertAdjacentElement(destination, baseMethod) {
    Utilities.setPropertyUnchecked(destination, 'insertAdjacentElement',
      /**
       * @this {Element}
       * @param {string} where
       * @param {!Element} element
       * @return {?Element}
       */
      function(where, element) {
        const wasConnected = Utilities.isConnected(element);
        const insertedElement = /** @type {!Element} */
          (baseMethod.call(this, where, element));

        if (wasConnected) {
          internals.disconnectTree(element);
        }

        if (Utilities.isConnected(insertedElement)) {
          internals.connectTree(element);
        }
        return insertedElement;
      });
  }

  if (Env.HTMLElement.insertAdjacentElement && Env.HTMLElement.insertAdjacentElement.value) {
    patch_insertAdjacentElement(HTMLElement.prototype, Env.HTMLElement.insertAdjacentElement.value);
  } else if (EnvElement.insertAdjacentElement && EnvElement.insertAdjacentElement.value) {
    patch_insertAdjacentElement(Element.prototype, EnvElement.insertAdjacentElement.value);
  } else {
    console.warn('Custom Elements: `Element#insertAdjacentElement` was not patched.');
  }


  PatchParentNode(internals, Element.prototype, {
    prepend: (EnvElement.prepend || {}).value,
    append: (EnvElement.append || {}).value,
  });

  PatchChildNode(internals, Element.prototype, {
    before: (EnvElement.before || {}).value,
    after: (EnvElement.after || {}).value,
    replaceWith: (EnvElement.replaceWith || {}).value,
    remove: (EnvElement.remove || {}).value,
  });
};
