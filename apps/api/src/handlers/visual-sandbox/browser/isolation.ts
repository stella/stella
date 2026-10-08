export const VISUAL_BLOCKED_GLOBALS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
  "RTCDataChannelEvent",
  "RTCCertificate",
  "RTCDTMFSender",
  "RTCDTMFToneChangeEvent",
  "RTCDtlsTransport",
  "RTCEncodedAudioFrame",
  "RTCEncodedVideoFrame",
  "RTCError",
  "RTCErrorEvent",
  "RTCIceCandidate",
  "RTCIceCandidatePair",
  "RTCIceTransport",
  "RTCIdentityAssertion",
  "RTCPeerConnectionIceErrorEvent",
  "RTCPeerConnectionIceEvent",
  "RTCRtpReceiver",
  "RTCRtpScriptTransform",
  "RTCRtpScriptTransformer",
  "RTCRtpSender",
  "RTCRtpTransceiver",
  "RTCSctpTransport",
  "RTCSessionDescription",
  "RTCStatsReport",
  "RTCTrackEvent",
  "RTCTransformEvent",
  "WebSocket",
  "WebSocketError",
  "WebSocketStream",
  "WebTransport",
  "WebTransportBidirectionalStream",
  "WebTransportDatagramDuplexStream",
  "WebTransportDatagramsWritable",
  "WebTransportError",
  "WebTransportReceiveStream",
  "WebTransportSendGroup",
  "WebTransportSendStream",
  "EventSource",
  "Worker",
  "SharedWorker",
  "ServiceWorker",
  "ServiceWorkerContainer",
  "ServiceWorkerRegistration",
  "WorkerGlobalScope",
  "DedicatedWorkerGlobalScope",
  "SharedWorkerGlobalScope",
  "ServiceWorkerGlobalScope",
  "XMLHttpRequest",
  "fetch",
  "open",
] as const;

type NativeMethod = (this: unknown, ...args: unknown[]) => unknown;

const isNativeMethod = (value: unknown): value is NativeMethod =>
  typeof value === "function";

const createNativeCapture = (reject: () => never) => {
  const descriptorOf = Object.getOwnPropertyDescriptor;
  return (
    target: object,
    name: string,
    kind: "value" | "get" | "set" = "value",
  ) => {
    const descriptor = descriptorOf(target, name);
    const native: unknown = descriptor?.[kind];
    if (!isNativeMethod(native)) {
      return reject();
    }
    return native;
  };
};

const createStringReader = (reject: () => never) => (value: unknown) => {
  if (typeof value !== "string") {
    return reject();
  }
  return value;
};

const createIsolationPrimitives = () => {
  // Keep native operations private before page scripts can replace globals,
  // prototype methods, or instance accessors used by these checks.
  const nativeApply = Reflect.apply;
  const apply = (
    method: NativeMethod,
    receiver: unknown,
    args: unknown[],
  ): unknown => nativeApply(method, receiver, args);
  const defineProperty = Object.defineProperty;
  const descriptorOf = Object.getOwnPropertyDescriptor;
  const prototypeOf = Object.getPrototypeOf;
  const get = Reflect.get;
  const stringify = String;
  const TemplateType = HTMLTemplateElement;
  const ExceptionType = DOMException;
  const ObserverType = MutationObserver;
  const reject = () => {
    throw new ExceptionType(
      "This operation is unavailable in this view",
      "SecurityError",
    );
  };
  const captureNative = createNativeCapture(reject);
  const attribute = captureNative(Element.prototype, "getAttribute");
  const remove = captureNative(Element.prototype, "remove");
  const nodeItem = captureNative(NodeList.prototype, "item");
  const readTagName = captureNative(Element.prototype, "tagName", "get");
  const readNodeType = captureNative(Node.prototype, "nodeType", "get");
  const readNamespace = captureNative(Element.prototype, "namespaceURI", "get");
  const readTemplateContent = captureNative(
    TemplateType.prototype,
    "content",
    "get",
  );
  const readHtml = captureNative(Element.prototype, "innerHTML", "get");
  const setHtml = captureNative(Element.prototype, "innerHTML", "set");
  const selectors = captureNative(
    DocumentFragment.prototype,
    "querySelectorAll",
  );
  const documentSelectors = captureNative(
    Document.prototype,
    "querySelectorAll",
  );
  const elementSelectors = captureNative(Element.prototype, "querySelectorAll");
  const createElement = captureNative(Document.prototype, "createElement");
  const passwordHint = /password|passwd|credential|one-time-code/iu;
  const regexExec = captureNative(RegExp.prototype, "exec");
  const lower = captureNative(String.prototype, "toLowerCase");
  const trim = captureNative(String.prototype, "trim");
  const requireString = createStringReader(reject);
  const normalize = (value: unknown) =>
    requireString(apply(lower, apply(trim, value, []), []));
  const attr = (element: Element, name: string) => {
    const value = apply(attribute, element, [name]);
    return value === null ? "" : requireString(value);
  };
  // Native brand checks also work after a page changes a node's prototype.
  // Object arguments that are not DOM nodes are refused by these wrappers.
  const isNode = (value: unknown): value is Node => {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    apply(readNodeType, value, []);
    return true;
  };
  const isElement = (node: unknown): node is Element =>
    isNode(node) && apply(readNodeType, node, []) === 1;
  const isTemplate = (node: Node) =>
    isElement(node) &&
    normalize(apply(readTagName, node, [])) === "template" &&
    apply(readNamespace, node, []) === "http://www.w3.org/1999/xhtml";
  const isProhibited = (element: Element) => {
    const tag = normalize(apply(readTagName, element, []));
    switch (tag) {
      case "iframe":
      case "frame":
      case "frameset":
      case "object":
      case "embed":
      case "base":
      case "link":
      case "form":
        return true;
      case "meta":
        return normalize(attr(element, "http-equiv")) === "refresh";
      case "script":
        return normalize(attr(element, "type")) === "speculationrules";
      case "input":
        return (
          normalize(attr(element, "type")) === "password" ||
          apply(regexExec, passwordHint, [attr(element, "name")]) !== null ||
          apply(regexExec, passwordHint, [attr(element, "id")]) !== null ||
          apply(regexExec, passwordHint, [attr(element, "autocomplete")]) !==
            null
        );
      default:
        return false;
    }
  };
  const inspect = (input: unknown) => {
    const node = isNode(input) ? input : reject();
    const elementNode = isElement(node);
    const kind = apply(readNodeType, node, []);
    const documentNode = kind === 9;
    if (!elementNode && !documentNode && kind !== 11) {
      return;
    }
    if (isElement(node) && isProhibited(node)) {
      reject();
    }
    if (isTemplate(node)) {
      inspect(apply(readTemplateContent, node, []));
    }
    // Native selector results are private snapshots; page-owned NodeList
    // accessors and iterators cannot hide descendants from inspection.
    let query = selectors;
    if (elementNode) {
      query = elementSelectors;
    } else if (documentNode) {
      query = documentSelectors;
    }
    const matches = apply(query, node, ["*"]);
    for (let index = 0; ; index += 1) {
      const item = apply(nodeItem, matches, [index]);
      if (item === null) {
        break;
      }
      const element = isElement(item) ? item : reject();
      if (isProhibited(element)) {
        reject();
      }
      if (isTemplate(element)) {
        inspect(apply(readTemplateContent, element, []));
      }
    }
  };
  const parseMarkup = (markup: unknown) => {
    const template = apply(createElement, document, ["template"]);
    apply(setHtml, template, [stringify(markup)]);
    inspect(apply(readTemplateContent, template, []));
    return requireString(apply(readHtml, template, []));
  };
  type LockPropertyOptions = { target: object; name: string; value: unknown };
  const lockProperty = ({ target, name, value }: LockPropertyOptions) => {
    let current: object | null = target;
    while (current) {
      const descriptor = descriptorOf(current, name);
      if (current === target || descriptor) {
        defineProperty(current, name, {
          value,
          writable: false,
          configurable: false,
          enumerable: descriptor?.enumerable ?? false,
        });
      }
      const prototype: unknown = prototypeOf(current);
      current =
        prototype === null ||
        typeof prototype === "object" ||
        typeof prototype === "function"
          ? prototype
          : reject();
    }
  };
  const wrapInsertion = (target: object, name: string) => {
    const method: unknown = get(target, name);
    if (!isNativeMethod(method)) {
      return;
    }
    lockProperty({
      target,
      name,
      value(this: Node, ...args: unknown[]) {
        let index = 0;
        while (index < args.length) {
          const argument = args[index];
          index += 1;
          if (isNode(argument)) {
            inspect(argument);
          }
        }
        return apply(method, this, args);
      },
    });
  };
  return {
    apply,
    descriptorOf,
    captureNative,
    defineProperty,
    get,
    lockProperty,
    wrapInsertion,
    parseMarkup,
    isElement,
    isProhibited,
    nodeItem,
    remove,
    elementSelectors,
    ObserverType,
    reject,
  };
};

export const isolateVisualGuest = () => {
  const {
    apply,
    descriptorOf,
    captureNative,
    defineProperty,
    get,
    lockProperty,
    wrapInsertion,
    parseMarkup,
    isElement,
    isProhibited,
    nodeItem,
    remove,
    elementSelectors,
    ObserverType,
    reject,
  } = createIsolationPrimitives();
  for (const name of VISUAL_BLOCKED_GLOBALS) {
    lockProperty({ target: window, name, value: undefined });
  }
  for (const name of ["mediaDevices", "serviceWorker", "sendBeacon"]) {
    lockProperty({ target: navigator, name, value: undefined });
  }
  for (const name of ["open", "write", "writeln", "execCommand"]) {
    lockProperty({ target: document, name, value: undefined });
  }
  for (const name of ["appendChild", "insertBefore", "replaceChild"]) {
    wrapInsertion(Node.prototype, name);
  }
  for (const target of [
    Element.prototype,
    Document.prototype,
    DocumentFragment.prototype,
  ]) {
    for (const name of ["append", "prepend", "replaceChildren"]) {
      wrapInsertion(target, name);
    }
  }
  for (const target of [
    Element.prototype,
    CharacterData.prototype,
    DocumentType.prototype,
  ]) {
    for (const name of ["before", "after", "replaceWith"]) {
      wrapInsertion(target, name);
    }
  }
  for (const name of ["insertNode", "surroundContents"]) {
    wrapInsertion(Range.prototype, name);
  }
  wrapInsertion(Element.prototype, "insertAdjacentElement");
  for (const target of [Element.prototype, ShadowRoot.prototype]) {
    for (const name of ["innerHTML", "outerHTML"]) {
      const descriptor = descriptorOf(target, name);
      if (!descriptor?.set) {
        continue;
      }
      const setter = captureNative(target, name, "set");
      defineProperty(target, name, {
        ...descriptor,
        configurable: false,
        set(this: Element | ShadowRoot, value: unknown) {
          apply(setter, this, [parseMarkup(value)]);
        },
      });
    }
    for (const name of ["setHTML", "setHTMLUnsafe", "insertAdjacentHTML"]) {
      const method: unknown = get(target, name);
      if (!isNativeMethod(method)) {
        continue;
      }
      lockProperty({
        target,
        name,
        value(this: Element | ShadowRoot, ...args: unknown[]) {
          const index = name === "insertAdjacentHTML" ? 1 : 0;
          args[index] = parseMarkup(args[index]);
          return apply(method, this, args);
        },
      });
    }
  }
  const strip = (node: unknown) => {
    if (!isElement(node)) {
      return;
    }
    if (isProhibited(node)) {
      apply(remove, node, []);
      return;
    }
    const matches = apply(elementSelectors, node, ["*"]);
    for (let index = 0; ; index += 1) {
      const item = apply(nodeItem, matches, [index]);
      if (item === null) {
        break;
      }
      const element = isElement(item) ? item : reject();
      if (isProhibited(element)) {
        apply(remove, element, []);
      }
    }
  };
  const readMutationTarget = captureNative(
    MutationRecord.prototype,
    "target",
    "get",
  );
  const readMutationNodes = captureNative(
    MutationRecord.prototype,
    "addedNodes",
    "get",
  );
  new ObserverType((records) => {
    let index = 0;
    while (index < records.length) {
      const record = records[index];
      index += 1;
      if (!record) {
        continue;
      }
      strip(apply(readMutationTarget, record, []));
      const addedNodes = apply(readMutationNodes, record, []);
      for (let nodeIndex = 0; ; nodeIndex += 1) {
        const node = apply(nodeItem, addedNodes, [nodeIndex]);
        if (node === null) {
          break;
        }
        strip(node);
      }
    }
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
  });
};
