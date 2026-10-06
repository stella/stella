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
  "WebTransportError",
  "WebTransportReceiveStream",
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

const createIsolationPrimitives = () => {
  // Keep native operations private before page scripts can replace globals,
  // prototype methods, or instance accessors used by these checks.
  const apply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const descriptorOf = Object.getOwnPropertyDescriptor;
  const prototypeOf = Object.getPrototypeOf;
  const get = Reflect.get;
  const stringify = String;
  const TemplateType = HTMLTemplateElement;
  const ExceptionType = DOMException;
  const ObserverType = MutationObserver;
  const attribute = Element.prototype.getAttribute;
  const remove = Element.prototype.remove;
  const nodeItem: unknown = descriptorOf(NodeList.prototype, "item")?.value;
  const tagName = descriptorOf(Element.prototype, "tagName")?.get;
  const nodeType = descriptorOf(Node.prototype, "nodeType")?.get;
  const namespace = descriptorOf(Element.prototype, "namespaceURI")?.get;
  const templateContent = descriptorOf(TemplateType.prototype, "content")?.get;
  const innerHtml = descriptorOf(Element.prototype, "innerHTML");
  const selectors = DocumentFragment.prototype.querySelectorAll;
  const documentSelectors = Document.prototype.querySelectorAll;
  const elementSelectors = Element.prototype.querySelectorAll;
  const createElement = document.createElement.bind(document);
  const reject = () => {
    throw new ExceptionType(
      "This operation is unavailable in this view",
      "SecurityError",
    );
  };
  if (
    typeof nodeItem !== "function" ||
    !tagName ||
    !nodeType ||
    !namespace ||
    !templateContent ||
    !innerHtml?.get ||
    !innerHtml.set
  ) {
    return reject();
  }
  const readTagName = tagName;
  const readNodeType = nodeType;
  const readNamespace = namespace;
  const readTemplateContent = templateContent;
  const readHtml = innerHtml.get;
  const setHtml = innerHtml.set;
  const passwordHint = /password|passwd|credential|one-time-code/iu;
  const regexExec = RegExp.prototype.exec;
  const lower = String.prototype.toLowerCase;
  const trim = String.prototype.trim;
  const normalize = (value: string) => apply(lower, apply(trim, value, []), []);
  const attr = (element: Element, name: string): string =>
    apply(attribute, element, [name]) ?? "";
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
  const inspect = (node: Node) => {
    const elementNode = isElement(node);
    const kind: number = apply(readNodeType, node, []);
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
    const matches: NodeListOf<Element> = apply(query, node, ["*"]);
    for (let index = 0; ; index += 1) {
      const element: unknown = apply(nodeItem, matches, [index]);
      if (!element) {
        break;
      }
      if (!isElement(element)) {
        return reject();
      }
      if (isProhibited(element)) {
        reject();
      }
      if (isTemplate(element)) {
        inspect(apply(readTemplateContent, element, []));
      }
    }
  };
  const parseMarkup = (markup: unknown) => {
    const template = createElement("template");
    apply(setHtml, template, [stringify(markup)]);
    inspect(apply(readTemplateContent, template, []));
    return apply(readHtml, template, []);
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
      current = prototypeOf(current);
    }
  };
  const wrapInsertion = (target: object, name: string) => {
    const method = get(target, name);
    if (typeof method !== "function") {
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
      const setter = descriptor.set;
      defineProperty(target, name, {
        ...descriptor,
        configurable: false,
        set(this: Element | ShadowRoot, value: unknown) {
          apply(setter, this, [parseMarkup(value)]);
        },
      });
    }
    for (const name of ["setHTML", "setHTMLUnsafe", "insertAdjacentHTML"]) {
      const method = get(target, name);
      if (typeof method !== "function") {
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
  const strip = (node: Node) => {
    if (!isElement(node)) {
      return;
    }
    if (isProhibited(node)) {
      apply(remove, node, []);
      return;
    }
    const matches: NodeListOf<Element> = apply(elementSelectors, node, ["*"]);
    for (let index = 0; ; index += 1) {
      const element: unknown = apply(nodeItem, matches, [index]);
      if (!element) {
        break;
      }
      if (!isElement(element)) {
        return reject();
      }
      if (isProhibited(element)) {
        apply(remove, element, []);
      }
    }
  };
  const mutationTarget = descriptorOf(MutationRecord.prototype, "target")?.get;
  const mutationNodes = descriptorOf(
    MutationRecord.prototype,
    "addedNodes",
  )?.get;
  if (!mutationTarget || !mutationNodes) {
    return reject();
  }
  const readMutationTarget = mutationTarget;
  const readMutationNodes = mutationNodes;
  new ObserverType((records) => {
    let index = 0;
    while (index < records.length) {
      const record = records[index];
      index += 1;
      if (!record) {
        continue;
      }
      strip(apply(readMutationTarget, record, []));
      const addedNodes: NodeList = apply(readMutationNodes, record, []);
      for (let nodeIndex = 0; ; nodeIndex += 1) {
        const node: Node | null = apply(nodeItem, addedNodes, [nodeIndex]);
        if (!node) {
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
