"use strict";
(() => {
  // node_modules/modern-screenshot/dist/index.mjs
  var _P = "p".charCodeAt(0);
  var _H = "H".charCodeAt(0);
  var _Y = "Y".charCodeAt(0);
  var _S = "s".charCodeAt(0);
  var PREFIX = "[modern-screenshot]";
  var IN_BROWSER = typeof window !== "undefined";
  var SUPPORT_WEB_WORKER = IN_BROWSER && "Worker" in window;
  var SUPPORT_ATOB = IN_BROWSER && "atob" in window;
  var SUPPORT_BTOA = IN_BROWSER && "btoa" in window;
  var _a;
  var USER_AGENT = IN_BROWSER ? (_a = window.navigator) == null ? void 0 : _a.userAgent : "";
  var IN_CHROME = USER_AGENT.includes("Chrome");
  var IN_SAFARI = USER_AGENT.includes("AppleWebKit") && !IN_CHROME;
  var IN_FIREFOX = USER_AGENT.includes("Firefox");
  var isContext = (value) => value && "__CONTEXT__" in value;
  var isCssFontFaceRule = (rule) => rule.constructor.name === "CSSFontFaceRule";
  var isCSSImportRule = (rule) => rule.constructor.name === "CSSImportRule";
  var isLayerBlockRule = (rule) => rule.constructor.name === "CSSLayerBlockRule";
  var isElementNode = (node) => node.nodeType === 1;
  var isSVGElementNode = (node) => typeof node.className === "object";
  var isSVGImageElementNode = (node) => node.tagName === "image";
  var isSVGUseElementNode = (node) => node.tagName === "use";
  var isHTMLElementNode = (node) => isElementNode(node) && typeof node.style !== "undefined" && !isSVGElementNode(node);
  var isCommentNode = (node) => node.nodeType === 8;
  var isTextNode = (node) => node.nodeType === 3;
  var isImageElement = (node) => node.tagName === "IMG";
  var isVideoElement = (node) => node.tagName === "VIDEO";
  var isCanvasElement = (node) => node.tagName === "CANVAS";
  var isTextareaElement = (node) => node.tagName === "TEXTAREA";
  var isInputElement = (node) => node.tagName === "INPUT";
  var isStyleElement = (node) => node.tagName === "STYLE";
  var isScriptElement = (node) => node.tagName === "SCRIPT";
  var isSelectElement = (node) => node.tagName === "SELECT";
  var isSlotElement = (node) => node.tagName === "SLOT";
  var isIFrameElement = (node) => node.tagName === "IFRAME";
  var consoleWarn = (...args) => console.warn(PREFIX, ...args);
  function supportWebp(ownerDocument) {
    var _a2;
    const canvas = (_a2 = ownerDocument == null ? void 0 : ownerDocument.createElement) == null ? void 0 : _a2.call(ownerDocument, "canvas");
    if (canvas) {
      canvas.height = canvas.width = 1;
    }
    return Boolean(canvas) && "toDataURL" in canvas && Boolean(canvas.toDataURL("image/webp").includes("image/webp"));
  }
  var isDataUrl = (url) => url.startsWith("data:");
  function resolveUrl(url, baseUrl) {
    if (url.match(/^[a-z]+:\/\//i))
      return url;
    if (IN_BROWSER && url.match(/^\/\//))
      return window.location.protocol + url;
    if (url.match(/^[a-z]+:/i))
      return url;
    if (!IN_BROWSER)
      return url;
    const doc = getDocument().implementation.createHTMLDocument();
    const base = doc.createElement("base");
    const a = doc.createElement("a");
    doc.head.appendChild(base);
    doc.body.appendChild(a);
    if (baseUrl)
      base.href = baseUrl;
    a.href = url;
    return a.href;
  }
  function getDocument(target) {
    return (target && isElementNode(target) ? target == null ? void 0 : target.ownerDocument : target) ?? window.document;
  }
  var XMLNS = "http://www.w3.org/2000/svg";
  function createSvg(width, height, ownerDocument) {
    const svg = getDocument(ownerDocument).createElementNS(XMLNS, "svg");
    svg.setAttributeNS(null, "width", width.toString());
    svg.setAttributeNS(null, "height", height.toString());
    svg.setAttributeNS(null, "viewBox", `0 0 ${width} ${height}`);
    return svg;
  }
  function svgToDataUrl(svg, removeControlCharacter) {
    let xhtml = new XMLSerializer().serializeToString(svg);
    if (removeControlCharacter) {
      xhtml = xhtml.replace(/[\u0000-\u0008\v\f\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, "");
    }
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xhtml)}`;
  }
  function readBlob(blob, type) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.onabort = () => reject(new Error(`Failed read blob to ${type}`));
      if (type === "dataUrl") {
        reader.readAsDataURL(blob);
      } else if (type === "arrayBuffer") {
        reader.readAsArrayBuffer(blob);
      }
    });
  }
  var blobToDataUrl = (blob) => readBlob(blob, "dataUrl");
  function createImage(url, ownerDocument) {
    const img = getDocument(ownerDocument).createElement("img");
    img.decoding = "sync";
    img.loading = "eager";
    img.src = url;
    return img;
  }
  function loadMedia(media, options) {
    return new Promise((resolve) => {
      const { timeout, ownerDocument, onError: userOnError, onWarn } = options ?? {};
      const node = typeof media === "string" ? createImage(media, getDocument(ownerDocument)) : media;
      let timer = null;
      let removeEventListeners = null;
      function onResolve() {
        resolve(node);
        timer && clearTimeout(timer);
        removeEventListeners == null ? void 0 : removeEventListeners();
      }
      if (timeout) {
        timer = setTimeout(onResolve, timeout);
      }
      if (isVideoElement(node)) {
        const currentSrc = node.currentSrc || node.src;
        if (!currentSrc) {
          if (node.poster) {
            return loadMedia(node.poster, options).then(resolve);
          }
          return onResolve();
        }
        if (node.readyState >= 2) {
          return onResolve();
        }
        const onLoadeddata = onResolve;
        const onError = (error) => {
          onWarn == null ? void 0 : onWarn(
            "Failed video load",
            currentSrc,
            error
          );
          userOnError == null ? void 0 : userOnError(error);
          onResolve();
        };
        removeEventListeners = () => {
          node.removeEventListener("loadeddata", onLoadeddata);
          node.removeEventListener("error", onError);
        };
        node.addEventListener("loadeddata", onLoadeddata, { once: true });
        node.addEventListener("error", onError, { once: true });
      } else {
        const currentSrc = isSVGImageElementNode(node) ? node.href.baseVal : node.currentSrc || node.src;
        if (!currentSrc) {
          return onResolve();
        }
        const onLoad = async () => {
          if (isImageElement(node) && "decode" in node) {
            try {
              await node.decode();
            } catch (error) {
              onWarn == null ? void 0 : onWarn(
                "Failed to decode image, trying to render anyway",
                node.dataset.originalSrc || currentSrc,
                error
              );
            }
          }
          onResolve();
        };
        const onError = (error) => {
          onWarn == null ? void 0 : onWarn(
            "Failed image load",
            node.dataset.originalSrc || currentSrc,
            error
          );
          onResolve();
        };
        if (isImageElement(node) && node.complete) {
          return onLoad();
        }
        removeEventListeners = () => {
          node.removeEventListener("load", onLoad);
          node.removeEventListener("error", onError);
        };
        node.addEventListener("load", onLoad, { once: true });
        node.addEventListener("error", onError, { once: true });
      }
    });
  }
  async function waitUntilLoad(node, options) {
    if (isHTMLElementNode(node)) {
      if (isImageElement(node) || isVideoElement(node)) {
        await loadMedia(node, options);
      } else {
        await Promise.all(
          ["img", "video"].flatMap((selectors) => {
            return Array.from(node.querySelectorAll(selectors)).map((el) => loadMedia(el, options));
          })
        );
      }
    }
  }
  var uuid = /* @__PURE__ */ (function uuid2() {
    let counter = 0;
    const random = () => `0000${(Math.random() * 36 ** 4 << 0).toString(36)}`.slice(-4);
    return () => {
      counter += 1;
      return `u${random()}${counter}`;
    };
  })();
  function splitFontFamily(fontFamily) {
    return fontFamily == null ? void 0 : fontFamily.split(",").map((val) => val.trim().replace(/"|'/g, "").toLowerCase()).filter(Boolean);
  }
  var uid = 0;
  function createLogger(debug) {
    const prefix = `${PREFIX}[#${uid}]`;
    uid++;
    return {
      // eslint-disable-next-line no-console
      time: (label) => debug && console.time(`${prefix} ${label}`),
      // eslint-disable-next-line no-console
      timeEnd: (label) => debug && console.timeEnd(`${prefix} ${label}`),
      warn: (...args) => debug && consoleWarn(...args)
    };
  }
  function getDefaultRequestInit(bypassingCache) {
    return {
      cache: bypassingCache ? "no-cache" : "force-cache"
    };
  }
  async function orCreateContext(node, options) {
    return isContext(node) ? node : createContext(node, { ...options, autoDestruct: true });
  }
  async function createContext(node, options) {
    var _a2, _b;
    const { scale = 1, workerUrl, workerNumber = 1 } = options || {};
    const debug = Boolean(options == null ? void 0 : options.debug);
    const features = (options == null ? void 0 : options.features) ?? true;
    const ownerDocument = node.ownerDocument ?? (IN_BROWSER ? window.document : void 0);
    const ownerWindow = ((_a2 = node.ownerDocument) == null ? void 0 : _a2.defaultView) ?? (IN_BROWSER ? window : void 0);
    const requests = /* @__PURE__ */ new Map();
    const context = {
      // Options
      width: 0,
      height: 0,
      quality: 1,
      type: "image/png",
      scale,
      backgroundColor: null,
      style: null,
      filter: null,
      maximumCanvasSize: 0,
      timeout: 3e4,
      progress: null,
      debug,
      fetch: {
        requestInit: getDefaultRequestInit((_b = options == null ? void 0 : options.fetch) == null ? void 0 : _b.bypassingCache),
        placeholderImage: "data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        bypassingCache: false,
        ...options == null ? void 0 : options.fetch
      },
      fetchFn: null,
      font: {},
      drawImageInterval: 100,
      workerUrl: null,
      workerNumber,
      onCloneEachNode: null,
      onCloneNode: null,
      onEmbedNode: null,
      onCreateForeignObjectSvg: null,
      includeStyleProperties: null,
      autoDestruct: false,
      ...options,
      // InternalContext
      __CONTEXT__: true,
      log: createLogger(debug),
      node,
      ownerDocument,
      ownerWindow,
      dpi: scale === 1 ? null : 96 * scale,
      svgStyleElement: createStyleElement(ownerDocument),
      svgDefsElement: ownerDocument == null ? void 0 : ownerDocument.createElementNS(XMLNS, "defs"),
      svgStyles: /* @__PURE__ */ new Map(),
      defaultComputedStyles: /* @__PURE__ */ new Map(),
      workers: [
        ...Array.from({
          length: SUPPORT_WEB_WORKER && workerUrl && workerNumber ? workerNumber : 0
        })
      ].map(() => {
        try {
          const worker = new Worker(workerUrl);
          worker.onmessage = async (event) => {
            var _a3, _b2, _c, _d;
            const { url, result } = event.data;
            if (result) {
              (_b2 = (_a3 = requests.get(url)) == null ? void 0 : _a3.resolve) == null ? void 0 : _b2.call(_a3, result);
            } else {
              (_d = (_c = requests.get(url)) == null ? void 0 : _c.reject) == null ? void 0 : _d.call(_c, new Error(`Error receiving message from worker: ${url}`));
            }
          };
          worker.onmessageerror = (event) => {
            var _a3, _b2;
            const { url } = event.data;
            (_b2 = (_a3 = requests.get(url)) == null ? void 0 : _a3.reject) == null ? void 0 : _b2.call(_a3, new Error(`Error receiving message from worker: ${url}`));
          };
          return worker;
        } catch (error) {
          context.log.warn("Failed to new Worker", error);
          return null;
        }
      }).filter(Boolean),
      fontFamilies: /* @__PURE__ */ new Map(),
      fontCssTexts: /* @__PURE__ */ new Map(),
      acceptOfImage: `${[
        supportWebp(ownerDocument) && "image/webp",
        "image/svg+xml",
        "image/*",
        "*/*"
      ].filter(Boolean).join(",")};q=0.8`,
      requests,
      drawImageCount: 0,
      tasks: [],
      features,
      isEnable: (key) => {
        if (key === "restoreScrollPosition") {
          return typeof features === "boolean" ? false : features[key] ?? false;
        }
        if (typeof features === "boolean") {
          return features;
        }
        return features[key] ?? true;
      },
      shadowRoots: []
    };
    context.log.time("wait until load");
    await waitUntilLoad(node, { timeout: context.timeout, onWarn: context.log.warn });
    context.log.timeEnd("wait until load");
    const { width, height } = resolveBoundingBox(node, context);
    context.width = width;
    context.height = height;
    return context;
  }
  function createStyleElement(ownerDocument) {
    if (!ownerDocument)
      return void 0;
    const style = ownerDocument.createElement("style");
    const cssText = style.ownerDocument.createTextNode(`
.______background-clip--text {
  background-clip: text;
  -webkit-background-clip: text;
}
`);
    style.appendChild(cssText);
    return style;
  }
  function resolveBoundingBox(node, context) {
    let { width, height } = context;
    if (isElementNode(node) && (!width || !height)) {
      const box = node.getBoundingClientRect();
      width = width || box.width || Number(node.getAttribute("width")) || 0;
      height = height || box.height || Number(node.getAttribute("height")) || 0;
    }
    return { width, height };
  }
  async function imageToCanvas(image, context) {
    const {
      log,
      timeout,
      drawImageCount,
      drawImageInterval
    } = context;
    log.time("image to canvas");
    const loaded = await loadMedia(image, { timeout, onWarn: context.log.warn });
    const { canvas, context2d } = createCanvas(image.ownerDocument, context);
    const drawImage = () => {
      try {
        context2d == null ? void 0 : context2d.drawImage(loaded, 0, 0, canvas.width, canvas.height);
      } catch (error) {
        context.log.warn("Failed to drawImage", error);
      }
    };
    drawImage();
    if (context.isEnable("fixSvgXmlDecode")) {
      for (let i = 0; i < drawImageCount; i++) {
        await new Promise((resolve) => {
          setTimeout(() => {
            context2d == null ? void 0 : context2d.clearRect(0, 0, canvas.width, canvas.height);
            drawImage();
            resolve();
          }, i + drawImageInterval);
        });
      }
    }
    context.drawImageCount = 0;
    log.timeEnd("image to canvas");
    return canvas;
  }
  function createCanvas(ownerDocument, context) {
    const { width, height, scale, backgroundColor, maximumCanvasSize: max } = context;
    const canvas = ownerDocument.createElement("canvas");
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (max) {
      if (canvas.width > max || canvas.height > max) {
        if (canvas.width > max && canvas.height > max) {
          if (canvas.width > canvas.height) {
            canvas.height *= max / canvas.width;
            canvas.width = max;
          } else {
            canvas.width *= max / canvas.height;
            canvas.height = max;
          }
        } else if (canvas.width > max) {
          canvas.height *= max / canvas.width;
          canvas.width = max;
        } else {
          canvas.width *= max / canvas.height;
          canvas.height = max;
        }
      }
    }
    const context2d = canvas.getContext("2d");
    if (context2d && backgroundColor) {
      context2d.fillStyle = backgroundColor;
      context2d.fillRect(0, 0, canvas.width, canvas.height);
    }
    return { canvas, context2d };
  }
  function cloneCanvas(canvas, context) {
    if (canvas.ownerDocument) {
      try {
        const dataURL = canvas.toDataURL();
        if (dataURL !== "data:,") {
          return createImage(dataURL, canvas.ownerDocument);
        }
      } catch (error) {
        context.log.warn("Failed to clone canvas", error);
      }
    }
    const cloned = canvas.cloneNode(false);
    const ctx = canvas.getContext("2d");
    const clonedCtx = cloned.getContext("2d");
    try {
      if (ctx && clonedCtx) {
        clonedCtx.putImageData(
          ctx.getImageData(0, 0, canvas.width, canvas.height),
          0,
          0
        );
      }
      return cloned;
    } catch (error) {
      context.log.warn("Failed to clone canvas", error);
    }
    return cloned;
  }
  function cloneIframe(iframe, context) {
    var _a2;
    try {
      if ((_a2 = iframe == null ? void 0 : iframe.contentDocument) == null ? void 0 : _a2.documentElement) {
        return cloneNode(iframe.contentDocument.documentElement, context);
      }
    } catch (error) {
      context.log.warn("Failed to clone iframe", error);
    }
    return iframe.cloneNode(false);
  }
  function cloneImage(image) {
    const cloned = image.cloneNode(false);
    if (image.currentSrc && image.currentSrc !== image.src) {
      cloned.src = image.currentSrc;
      cloned.srcset = "";
    }
    if (cloned.loading === "lazy") {
      cloned.loading = "eager";
    }
    return cloned;
  }
  async function cloneVideo(video, context) {
    if (video.ownerDocument && !video.currentSrc && video.poster) {
      return createImage(video.poster, video.ownerDocument);
    }
    const cloned = video.cloneNode(false);
    cloned.crossOrigin = "anonymous";
    if (video.currentSrc && video.currentSrc !== video.src) {
      cloned.src = video.currentSrc;
    }
    const ownerDocument = cloned.ownerDocument;
    if (ownerDocument) {
      let canPlay = true;
      await loadMedia(cloned, { onError: () => canPlay = false, onWarn: context.log.warn });
      if (!canPlay) {
        if (video.poster) {
          return createImage(video.poster, video.ownerDocument);
        }
        return cloned;
      }
      cloned.currentTime = video.currentTime;
      await new Promise((resolve) => {
        cloned.addEventListener("seeked", resolve, { once: true });
      });
      const canvas = ownerDocument.createElement("canvas");
      canvas.width = video.offsetWidth;
      canvas.height = video.offsetHeight;
      try {
        const ctx = canvas.getContext("2d");
        if (ctx)
          ctx.drawImage(cloned, 0, 0, canvas.width, canvas.height);
      } catch (error) {
        context.log.warn("Failed to clone video", error);
        if (video.poster) {
          return createImage(video.poster, video.ownerDocument);
        }
        return cloned;
      }
      return cloneCanvas(canvas, context);
    }
    return cloned;
  }
  function cloneElement(node, context) {
    if (isCanvasElement(node)) {
      return cloneCanvas(node, context);
    }
    if (isIFrameElement(node)) {
      return cloneIframe(node, context);
    }
    if (isImageElement(node)) {
      return cloneImage(node);
    }
    if (isVideoElement(node)) {
      return cloneVideo(node, context);
    }
    return node.cloneNode(false);
  }
  function getSandBox(context) {
    let sandbox = context.sandbox;
    if (!sandbox) {
      const { ownerDocument } = context;
      try {
        if (ownerDocument) {
          sandbox = ownerDocument.createElement("iframe");
          sandbox.id = `__SANDBOX__${uuid()}`;
          sandbox.width = "0";
          sandbox.height = "0";
          sandbox.style.visibility = "hidden";
          sandbox.style.position = "fixed";
          ownerDocument.body.appendChild(sandbox);
          sandbox.srcdoc = '<!DOCTYPE html><meta charset="UTF-8"><title></title><body>';
          context.sandbox = sandbox;
        }
      } catch (error) {
        context.log.warn("Failed to getSandBox", error);
      }
    }
    return sandbox;
  }
  var ignoredStyles = [
    "width",
    "height",
    "-webkit-text-fill-color"
  ];
  var includedAttributes = [
    "stroke",
    "fill"
  ];
  function getDefaultStyle(node, pseudoElement, context) {
    const { defaultComputedStyles } = context;
    const nodeName = node.nodeName.toLowerCase();
    const isSvgNode = isSVGElementNode(node) && nodeName !== "svg";
    const attributes = isSvgNode ? includedAttributes.map((name) => [name, node.getAttribute(name)]).filter(([, value]) => value !== null) : [];
    const key = [
      isSvgNode && "svg",
      nodeName,
      attributes.map((name, value) => `${name}=${value}`).join(","),
      pseudoElement
    ].filter(Boolean).join(":");
    if (defaultComputedStyles.has(key))
      return defaultComputedStyles.get(key);
    const sandbox = getSandBox(context);
    const sandboxWindow = sandbox == null ? void 0 : sandbox.contentWindow;
    if (!sandboxWindow)
      return /* @__PURE__ */ new Map();
    const sandboxDocument = sandboxWindow == null ? void 0 : sandboxWindow.document;
    let root;
    let el;
    if (isSvgNode) {
      root = sandboxDocument.createElementNS(XMLNS, "svg");
      el = root.ownerDocument.createElementNS(root.namespaceURI, nodeName);
      attributes.forEach(([name, value]) => {
        el.setAttributeNS(null, name, value);
      });
      root.appendChild(el);
    } else {
      root = el = sandboxDocument.createElement(nodeName);
    }
    el.textContent = " ";
    sandboxDocument.body.appendChild(root);
    const computedStyle = sandboxWindow.getComputedStyle(el, pseudoElement);
    const styles = /* @__PURE__ */ new Map();
    for (let len = computedStyle.length, i = 0; i < len; i++) {
      const name = computedStyle.item(i);
      if (ignoredStyles.includes(name))
        continue;
      styles.set(name, computedStyle.getPropertyValue(name));
    }
    sandboxDocument.body.removeChild(root);
    defaultComputedStyles.set(key, styles);
    return styles;
  }
  function getDiffStyle(style, defaultStyle, includeStyleProperties) {
    var _a2;
    const diffStyle = /* @__PURE__ */ new Map();
    const prefixs = [];
    const prefixTree = /* @__PURE__ */ new Map();
    if (includeStyleProperties) {
      for (const name of includeStyleProperties) {
        applyTo(name);
      }
    } else {
      for (let len = style.length, i = 0; i < len; i++) {
        const name = style.item(i);
        applyTo(name);
      }
    }
    for (let len = prefixs.length, i = 0; i < len; i++) {
      (_a2 = prefixTree.get(prefixs[i])) == null ? void 0 : _a2.forEach((value, name) => diffStyle.set(name, value));
    }
    function applyTo(name) {
      const value = style.getPropertyValue(name);
      const priority = style.getPropertyPriority(name);
      const subIndex = name.lastIndexOf("-");
      const prefix = subIndex > -1 ? name.substring(0, subIndex) : void 0;
      if (prefix) {
        let map = prefixTree.get(prefix);
        if (!map) {
          map = /* @__PURE__ */ new Map();
          prefixTree.set(prefix, map);
        }
        map.set(name, [value, priority]);
      }
      if (defaultStyle.get(name) === value && !priority)
        return;
      if (prefix) {
        prefixs.push(prefix);
      } else {
        diffStyle.set(name, [value, priority]);
      }
    }
    return diffStyle;
  }
  function copyCssStyles(node, cloned, isRoot, context) {
    var _a2, _b, _c, _d;
    const { ownerWindow, includeStyleProperties, currentParentNodeStyle } = context;
    const clonedStyle = cloned.style;
    const computedStyle = ownerWindow.getComputedStyle(node);
    const defaultStyle = getDefaultStyle(node, null, context);
    currentParentNodeStyle == null ? void 0 : currentParentNodeStyle.forEach((_, key) => {
      defaultStyle.delete(key);
    });
    const style = getDiffStyle(computedStyle, defaultStyle, includeStyleProperties);
    style.delete("transition-property");
    style.delete("all");
    style.delete("d");
    style.delete("content");
    if (isRoot) {
      style.delete("position");
      style.delete("margin-top");
      style.delete("margin-right");
      style.delete("margin-bottom");
      style.delete("margin-left");
      style.delete("margin-block-start");
      style.delete("margin-block-end");
      style.delete("margin-inline-start");
      style.delete("margin-inline-end");
      style.set("box-sizing", ["border-box", ""]);
    }
    if (((_a2 = style.get("background-clip")) == null ? void 0 : _a2[0]) === "text") {
      cloned.classList.add("______background-clip--text");
    }
    if (IN_CHROME) {
      if (!style.has("font-kerning"))
        style.set("font-kerning", ["normal", ""]);
      if ((((_b = style.get("overflow-x")) == null ? void 0 : _b[0]) === "hidden" || ((_c = style.get("overflow-y")) == null ? void 0 : _c[0]) === "hidden") && ((_d = style.get("text-overflow")) == null ? void 0 : _d[0]) === "ellipsis" && node.scrollWidth === node.clientWidth) {
        style.set("text-overflow", ["clip", ""]);
      }
    }
    for (let len = clonedStyle.length, i = 0; i < len; i++) {
      clonedStyle.removeProperty(clonedStyle.item(i));
    }
    style.forEach(([value, priority], name) => {
      clonedStyle.setProperty(name, value, priority);
    });
    return style;
  }
  function copyInputValue(node, cloned) {
    if (isTextareaElement(node) || isInputElement(node) || isSelectElement(node)) {
      cloned.setAttribute("value", node.value);
    }
  }
  var pseudoClasses = [
    "::before",
    "::after"
    // '::placeholder', TODO
  ];
  var scrollbarPseudoClasses = [
    "::-webkit-scrollbar",
    "::-webkit-scrollbar-button",
    // '::-webkit-scrollbar:horizontal', TODO
    "::-webkit-scrollbar-thumb",
    "::-webkit-scrollbar-track",
    "::-webkit-scrollbar-track-piece",
    // '::-webkit-scrollbar:vertical', TODO
    "::-webkit-scrollbar-corner",
    "::-webkit-resizer"
  ];
  function copyPseudoClass(node, cloned, copyScrollbar, context, addWordToFontFamilies) {
    const { ownerWindow, svgStyleElement, svgStyles, currentNodeStyle } = context;
    if (!svgStyleElement || !ownerWindow)
      return;
    function copyBy(pseudoClass) {
      var _a2;
      const computedStyle = ownerWindow.getComputedStyle(node, pseudoClass);
      let content = computedStyle.getPropertyValue("content");
      if (!content || content === "none")
        return;
      addWordToFontFamilies == null ? void 0 : addWordToFontFamilies(content);
      content = content.replace(/(')|(")|(counter\(.+\))/g, "");
      const klasses = [uuid()];
      const defaultStyle = getDefaultStyle(node, pseudoClass, context);
      currentNodeStyle == null ? void 0 : currentNodeStyle.forEach((_, key) => {
        defaultStyle.delete(key);
      });
      const style = getDiffStyle(computedStyle, defaultStyle, context.includeStyleProperties);
      style.delete("content");
      style.delete("-webkit-locale");
      if (((_a2 = style.get("background-clip")) == null ? void 0 : _a2[0]) === "text") {
        cloned.classList.add("______background-clip--text");
      }
      const cloneStyle = [
        `content: '${content}';`
      ];
      style.forEach(([value, priority], name) => {
        cloneStyle.push(`${name}: ${value}${priority ? " !important" : ""};`);
      });
      if (cloneStyle.length === 1)
        return;
      try {
        cloned.className = [cloned.className, ...klasses].join(" ");
      } catch (err) {
        context.log.warn("Failed to copyPseudoClass", err);
        return;
      }
      const cssText = cloneStyle.join("\n  ");
      let allClasses = svgStyles.get(cssText);
      if (!allClasses) {
        allClasses = [];
        svgStyles.set(cssText, allClasses);
      }
      allClasses.push(`.${klasses[0]}${pseudoClass}`);
    }
    pseudoClasses.forEach(copyBy);
    if (copyScrollbar)
      scrollbarPseudoClasses.forEach(copyBy);
  }
  var excludeParentNodes = /* @__PURE__ */ new Set([
    "symbol"
    // test/fixtures/svg.symbol.html
  ]);
  async function appendChildNode(node, cloned, child, context, addWordToFontFamilies) {
    if (isElementNode(child) && (isStyleElement(child) || isScriptElement(child)))
      return;
    if (context.filter && !context.filter(child))
      return;
    if (excludeParentNodes.has(cloned.nodeName) || excludeParentNodes.has(child.nodeName)) {
      context.currentParentNodeStyle = void 0;
    } else {
      context.currentParentNodeStyle = context.currentNodeStyle;
    }
    const childCloned = await cloneNode(child, context, false, addWordToFontFamilies);
    if (context.isEnable("restoreScrollPosition")) {
      restoreScrollPosition(node, childCloned);
    }
    cloned.appendChild(childCloned);
  }
  async function cloneChildNodes(node, cloned, context, addWordToFontFamilies) {
    var _a2;
    let firstChild = node.firstChild;
    if (isElementNode(node)) {
      if (node.shadowRoot) {
        firstChild = (_a2 = node.shadowRoot) == null ? void 0 : _a2.firstChild;
        context.shadowRoots.push(node.shadowRoot);
      }
    }
    for (let child = firstChild; child; child = child.nextSibling) {
      if (isCommentNode(child))
        continue;
      if (isElementNode(child) && isSlotElement(child) && typeof child.assignedNodes === "function") {
        const nodes = child.assignedNodes();
        for (let i = 0; i < nodes.length; i++) {
          await appendChildNode(node, cloned, nodes[i], context, addWordToFontFamilies);
        }
      } else {
        await appendChildNode(node, cloned, child, context, addWordToFontFamilies);
      }
    }
  }
  function restoreScrollPosition(node, chlidCloned) {
    if (!isHTMLElementNode(node) || !isHTMLElementNode(chlidCloned))
      return;
    const { scrollTop, scrollLeft } = node;
    if (!scrollTop && !scrollLeft) {
      return;
    }
    const { transform } = chlidCloned.style;
    const matrix = new DOMMatrix(transform);
    const { a, b, c, d } = matrix;
    matrix.a = 1;
    matrix.b = 0;
    matrix.c = 0;
    matrix.d = 1;
    matrix.translateSelf(-scrollLeft, -scrollTop);
    matrix.a = a;
    matrix.b = b;
    matrix.c = c;
    matrix.d = d;
    chlidCloned.style.transform = matrix.toString();
  }
  function applyCssStyleWithOptions(cloned, context) {
    const { backgroundColor, width, height, style: styles } = context;
    const clonedStyle = cloned.style;
    if (backgroundColor)
      clonedStyle.setProperty("background-color", backgroundColor, "important");
    if (width)
      clonedStyle.setProperty("width", `${width}px`, "important");
    if (height)
      clonedStyle.setProperty("height", `${height}px`, "important");
    if (styles) {
      for (const name in styles) clonedStyle[name] = styles[name];
    }
  }
  var NORMAL_ATTRIBUTE_RE = /^[\w-:]+$/;
  async function cloneNode(node, context, isRoot = false, addWordToFontFamilies) {
    var _a2, _b, _c, _d;
    const { ownerDocument, ownerWindow, fontFamilies, onCloneEachNode } = context;
    if (ownerDocument && isTextNode(node)) {
      if (addWordToFontFamilies && /\S/.test(node.data)) {
        addWordToFontFamilies(node.data);
      }
      return ownerDocument.createTextNode(node.data);
    }
    if (ownerDocument && ownerWindow && isElementNode(node) && (isHTMLElementNode(node) || isSVGElementNode(node))) {
      const cloned2 = await cloneElement(node, context);
      if (context.isEnable("removeAbnormalAttributes")) {
        const names = cloned2.getAttributeNames();
        for (let len = names.length, i = 0; i < len; i++) {
          const name = names[i];
          if (!NORMAL_ATTRIBUTE_RE.test(name)) {
            cloned2.removeAttribute(name);
          }
        }
      }
      const style = context.currentNodeStyle = copyCssStyles(node, cloned2, isRoot, context);
      if (isRoot)
        applyCssStyleWithOptions(cloned2, context);
      let copyScrollbar = false;
      if (context.isEnable("copyScrollbar")) {
        const overflow = [
          (_a2 = style.get("overflow-x")) == null ? void 0 : _a2[0],
          (_b = style.get("overflow-y")) == null ? void 0 : _b[0]
        ];
        copyScrollbar = overflow.includes("scroll") || (overflow.includes("auto") || overflow.includes("overlay")) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth);
      }
      const textTransform = (_c = style.get("text-transform")) == null ? void 0 : _c[0];
      const families = splitFontFamily((_d = style.get("font-family")) == null ? void 0 : _d[0]);
      const addWordToFontFamilies2 = families ? (word) => {
        if (textTransform === "uppercase") {
          word = word.toUpperCase();
        } else if (textTransform === "lowercase") {
          word = word.toLowerCase();
        } else if (textTransform === "capitalize") {
          word = word[0].toUpperCase() + word.substring(1);
        }
        families.forEach((family) => {
          let fontFamily = fontFamilies.get(family);
          if (!fontFamily) {
            fontFamilies.set(family, fontFamily = /* @__PURE__ */ new Set());
          }
          word.split("").forEach((text2) => fontFamily.add(text2));
        });
      } : void 0;
      copyPseudoClass(
        node,
        cloned2,
        copyScrollbar,
        context,
        addWordToFontFamilies2
      );
      copyInputValue(node, cloned2);
      if (!isVideoElement(node)) {
        await cloneChildNodes(
          node,
          cloned2,
          context,
          addWordToFontFamilies2
        );
      }
      await (onCloneEachNode == null ? void 0 : onCloneEachNode(cloned2));
      return cloned2;
    }
    const cloned = node.cloneNode(false);
    await cloneChildNodes(node, cloned, context);
    await (onCloneEachNode == null ? void 0 : onCloneEachNode(cloned));
    return cloned;
  }
  function destroyContext(context) {
    context.ownerDocument = void 0;
    context.ownerWindow = void 0;
    context.svgStyleElement = void 0;
    context.svgDefsElement = void 0;
    context.svgStyles.clear();
    context.defaultComputedStyles.clear();
    if (context.sandbox) {
      try {
        context.sandbox.remove();
      } catch (err) {
        context.log.warn("Failed to destroyContext", err);
      }
      context.sandbox = void 0;
    }
    context.workers = [];
    context.fontFamilies.clear();
    context.fontCssTexts.clear();
    context.requests.clear();
    context.tasks = [];
    context.shadowRoots = [];
  }
  function baseFetch(options) {
    const { url, timeout, responseType, ...requestInit } = options;
    const controller = new AbortController();
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : void 0;
    return fetch(url, { signal: controller.signal, ...requestInit }).then((response) => {
      if (!response.ok) {
        throw new Error("Failed fetch, not 2xx response", { cause: response });
      }
      switch (responseType) {
        case "arrayBuffer":
          return response.arrayBuffer();
        case "dataUrl":
          return response.blob().then(blobToDataUrl);
        case "text":
        default:
          return response.text();
      }
    }).finally(() => clearTimeout(timer));
  }
  function contextFetch(context, options) {
    const { url: rawUrl, requestType = "text", responseType = "text", imageDom } = options;
    let url = rawUrl;
    const {
      timeout,
      acceptOfImage,
      requests,
      fetchFn,
      fetch: {
        requestInit,
        bypassingCache,
        placeholderImage
      },
      font,
      workers,
      fontFamilies
    } = context;
    if (requestType === "image" && (IN_SAFARI || IN_FIREFOX)) {
      context.drawImageCount++;
    }
    let request = requests.get(rawUrl);
    if (!request) {
      if (bypassingCache) {
        if (bypassingCache instanceof RegExp && bypassingCache.test(url)) {
          url += (/\?/.test(url) ? "&" : "?") + (/* @__PURE__ */ new Date()).getTime();
        }
      }
      const canFontMinify = requestType.startsWith("font") && font && font.minify;
      const fontTexts = /* @__PURE__ */ new Set();
      if (canFontMinify) {
        const families = requestType.split(";")[1].split(",");
        families.forEach((family) => {
          if (!fontFamilies.has(family))
            return;
          fontFamilies.get(family).forEach((text2) => fontTexts.add(text2));
        });
      }
      const needFontMinify = canFontMinify && fontTexts.size;
      const baseFetchOptions = {
        url,
        timeout,
        responseType: needFontMinify ? "arrayBuffer" : responseType,
        headers: requestType === "image" ? { accept: acceptOfImage } : void 0,
        ...requestInit
      };
      request = {
        type: requestType,
        resolve: void 0,
        reject: void 0,
        response: null
      };
      request.response = (async () => {
        if (fetchFn && requestType === "image") {
          const result = await fetchFn(rawUrl);
          if (result)
            return result;
        }
        if (!IN_SAFARI && rawUrl.startsWith("http") && workers.length) {
          return new Promise((resolve, reject) => {
            const worker = workers[requests.size & workers.length - 1];
            worker.postMessage({ rawUrl, ...baseFetchOptions });
            request.resolve = resolve;
            request.reject = reject;
          });
        }
        return baseFetch(baseFetchOptions);
      })().catch((error) => {
        requests.delete(rawUrl);
        if (requestType === "image" && placeholderImage) {
          context.log.warn("Failed to fetch image base64, trying to use placeholder image", url);
          return typeof placeholderImage === "string" ? placeholderImage : placeholderImage(imageDom);
        }
        throw error;
      });
      requests.set(rawUrl, request);
    }
    return request.response;
  }
  async function replaceCssUrlToDataUrl(cssText, baseUrl, context, isImage) {
    if (!hasCssUrl(cssText))
      return cssText;
    for (const [rawUrl, url] of parseCssUrls(cssText, baseUrl)) {
      try {
        const dataUrl = await contextFetch(
          context,
          {
            url,
            requestType: isImage ? "image" : "text",
            responseType: "dataUrl"
          }
        );
        cssText = cssText.replace(toRE(rawUrl), `$1${dataUrl}$3`);
      } catch (error) {
        context.log.warn("Failed to fetch css data url", rawUrl, error);
      }
    }
    return cssText;
  }
  function hasCssUrl(cssText) {
    return /url\((['"]?)([^'"]+?)\1\)/.test(cssText);
  }
  var URL_RE = /url\((['"]?)([^'"]+?)\1\)/g;
  function parseCssUrls(cssText, baseUrl) {
    const result = [];
    cssText.replace(URL_RE, (raw, quotation, url) => {
      result.push([url, resolveUrl(url, baseUrl)]);
      return raw;
    });
    return result.filter(([url]) => !isDataUrl(url));
  }
  function toRE(url) {
    const escaped = url.replace(/([.*+?^${}()|\[\]\/\\])/g, "\\$1");
    return new RegExp(`(url\\(['"]?)(${escaped})(['"]?\\))`, "g");
  }
  var properties = [
    "background-image",
    "border-image-source",
    "-webkit-border-image",
    "-webkit-mask-image",
    "list-style-image"
  ];
  function embedCssStyleImage(style, context) {
    return properties.map((property) => {
      const value = style.getPropertyValue(property);
      if (!value || value === "none") {
        return null;
      }
      if (IN_SAFARI || IN_FIREFOX) {
        context.drawImageCount++;
      }
      return replaceCssUrlToDataUrl(value, null, context, true).then((newValue) => {
        if (!newValue || value === newValue)
          return;
        style.setProperty(
          property,
          newValue,
          style.getPropertyPriority(property)
        );
      });
    }).filter(Boolean);
  }
  function embedImageElement(cloned, context) {
    if (isImageElement(cloned)) {
      const originalSrc = cloned.currentSrc || cloned.src;
      if (!isDataUrl(originalSrc)) {
        return [
          contextFetch(context, {
            url: originalSrc,
            imageDom: cloned,
            requestType: "image",
            responseType: "dataUrl"
          }).then((url) => {
            if (!url)
              return;
            cloned.srcset = "";
            cloned.dataset.originalSrc = originalSrc;
            cloned.src = url || "";
          })
        ];
      }
      if (IN_SAFARI || IN_FIREFOX) {
        context.drawImageCount++;
      }
    } else if (isSVGElementNode(cloned) && !isDataUrl(cloned.href.baseVal)) {
      const originalSrc = cloned.href.baseVal;
      return [
        contextFetch(context, {
          url: originalSrc,
          imageDom: cloned,
          requestType: "image",
          responseType: "dataUrl"
        }).then((url) => {
          if (!url)
            return;
          cloned.dataset.originalSrc = originalSrc;
          cloned.href.baseVal = url || "";
        })
      ];
    }
    return [];
  }
  function embedSvgUse(cloned, context) {
    const { ownerDocument, svgDefsElement } = context;
    const href = cloned.getAttribute("href") ?? cloned.getAttribute("xlink:href");
    if (!href)
      return [];
    const [svgUrl, id] = href.split("#");
    if (id) {
      const query = `#${id}`;
      const definition = context.shadowRoots.reduce(
        (res, root) => {
          return res ?? root.querySelector(`svg ${query}`);
        },
        ownerDocument == null ? void 0 : ownerDocument.querySelector(`svg ${query}`)
      );
      if (svgUrl) {
        cloned.setAttribute("href", query);
      }
      if (svgDefsElement == null ? void 0 : svgDefsElement.querySelector(query))
        return [];
      if (definition) {
        svgDefsElement == null ? void 0 : svgDefsElement.appendChild(definition.cloneNode(true));
        return [];
      } else if (svgUrl) {
        return [
          contextFetch(context, {
            url: svgUrl,
            responseType: "text"
          }).then((svgData) => {
            svgDefsElement == null ? void 0 : svgDefsElement.insertAdjacentHTML("beforeend", svgData);
          })
        ];
      }
    }
    return [];
  }
  function embedNode(cloned, context) {
    const { tasks } = context;
    if (isElementNode(cloned)) {
      if (isImageElement(cloned) || isSVGImageElementNode(cloned)) {
        tasks.push(...embedImageElement(cloned, context));
      }
      if (isSVGUseElementNode(cloned)) {
        tasks.push(...embedSvgUse(cloned, context));
      }
    }
    if (isHTMLElementNode(cloned)) {
      tasks.push(...embedCssStyleImage(cloned.style, context));
    }
    cloned.childNodes.forEach((child) => {
      embedNode(child, context);
    });
  }
  async function embedWebFont(clone, context) {
    const {
      ownerDocument,
      svgStyleElement,
      fontFamilies,
      fontCssTexts,
      tasks,
      font
    } = context;
    if (!ownerDocument || !svgStyleElement || !fontFamilies.size) {
      return;
    }
    if (font && font.cssText) {
      const cssText = filterPreferredFormat(font.cssText, context);
      svgStyleElement.appendChild(ownerDocument.createTextNode(`${cssText}
`));
    } else {
      const styleSheets = Array.from(ownerDocument.styleSheets).filter((styleSheet) => {
        try {
          return "cssRules" in styleSheet && Boolean(styleSheet.cssRules.length);
        } catch (error) {
          context.log.warn(`Error while reading CSS rules from ${styleSheet.href}`, error);
          return false;
        }
      });
      const tempDoc = ownerDocument.implementation.createHTMLDocument("");
      const tempStyleEl = tempDoc.createElement("style");
      tempDoc.head.appendChild(tempStyleEl);
      const tempStyleSheet = tempStyleEl.sheet;
      await Promise.all(
        styleSheets.flatMap((styleSheet) => {
          return Array.from(styleSheet.cssRules).map(async (cssRule) => {
            if (isCSSImportRule(cssRule)) {
              const baseUrl = cssRule.href;
              let cssText = "";
              try {
                cssText = await contextFetch(context, {
                  url: baseUrl,
                  requestType: "text",
                  responseType: "text"
                });
              } catch (error) {
                context.log.warn(`Error fetch remote css import from ${baseUrl}`, error);
              }
              const replacedCssText = cssText.replace(
                URL_RE,
                (raw, quotation, url) => raw.replace(url, resolveUrl(url, baseUrl))
              );
              for (const rule of parseCss(replacedCssText)) {
                try {
                  tempStyleSheet.insertRule(rule, tempStyleSheet.cssRules.length);
                } catch (error) {
                  context.log.warn("Error inserting rule from remote css import", { rule, error });
                }
              }
            }
          });
        })
      );
      if (tempStyleSheet.cssRules.length)
        styleSheets.push(tempStyleSheet);
      const cssRules = [];
      styleSheets.forEach((sheet) => {
        unwrapCssLayers(sheet.cssRules, cssRules);
      });
      cssRules.filter((cssRule) => {
        var _a2;
        return isCssFontFaceRule(cssRule) && hasCssUrl(cssRule.style.getPropertyValue("src")) && ((_a2 = splitFontFamily(cssRule.style.getPropertyValue("font-family"))) == null ? void 0 : _a2.some((val) => fontFamilies.has(val)));
      }).forEach((value) => {
        const rule = value;
        const cssText = fontCssTexts.get(rule.cssText);
        if (cssText) {
          svgStyleElement.appendChild(ownerDocument.createTextNode(`${cssText}
`));
        } else {
          tasks.push(
            replaceCssUrlToDataUrl(
              rule.cssText,
              rule.parentStyleSheet ? rule.parentStyleSheet.href : null,
              context
            ).then((cssText2) => {
              cssText2 = filterPreferredFormat(cssText2, context);
              fontCssTexts.set(rule.cssText, cssText2);
              svgStyleElement.appendChild(ownerDocument.createTextNode(`${cssText2}
`));
            })
          );
        }
      });
    }
  }
  var COMMENTS_RE = /(\/\*[\s\S]*?\*\/)/g;
  var KEYFRAMES_RE = /((@.*?keyframes [\s\S]*?){([\s\S]*?}\s*?)})/gi;
  function parseCss(source) {
    if (source == null)
      return [];
    const result = [];
    let cssText = source.replace(COMMENTS_RE, "");
    while (true) {
      const matches2 = KEYFRAMES_RE.exec(cssText);
      if (!matches2)
        break;
      result.push(matches2[0]);
    }
    cssText = cssText.replace(KEYFRAMES_RE, "");
    const IMPORT_RE = /@import[\s\S]*?url\([^)]*\)[\s\S]*?;/gi;
    const UNIFIED_RE = new RegExp(
      // eslint-disable-next-line
      "((\\s*?(?:\\/\\*[\\s\\S]*?\\*\\/)?\\s*?@media[\\s\\S]*?){([\\s\\S]*?)}\\s*?})|(([\\s\\S]*?){([\\s\\S]*?)})",
      "gi"
    );
    while (true) {
      let matches2 = IMPORT_RE.exec(cssText);
      if (!matches2) {
        matches2 = UNIFIED_RE.exec(cssText);
        if (!matches2) {
          break;
        } else {
          IMPORT_RE.lastIndex = UNIFIED_RE.lastIndex;
        }
      } else {
        UNIFIED_RE.lastIndex = IMPORT_RE.lastIndex;
      }
      result.push(matches2[0]);
    }
    return result;
  }
  var URL_WITH_FORMAT_RE = /url\([^)]+\)\s*format\((["']?)([^"']+)\1\)/g;
  var FONT_SRC_RE = /src:\s*(?:url\([^)]+\)\s*format\([^)]+\)[,;]\s*)+/g;
  function filterPreferredFormat(str, context) {
    const { font } = context;
    const preferredFormat = font ? font == null ? void 0 : font.preferredFormat : void 0;
    return preferredFormat ? str.replace(FONT_SRC_RE, (match) => {
      while (true) {
        const [src, , format] = URL_WITH_FORMAT_RE.exec(match) || [];
        if (!format)
          return "";
        if (format === preferredFormat)
          return `src: ${src};`;
      }
    }) : str;
  }
  function unwrapCssLayers(rules, out = []) {
    for (const rule of Array.from(rules)) {
      if (isLayerBlockRule(rule)) {
        out.push(...unwrapCssLayers(rule.cssRules));
      } else if ("cssRules" in rule) {
        unwrapCssLayers(rule.cssRules, out);
      } else {
        out.push(rule);
      }
    }
    return out;
  }
  var SVG_EXTERNAL_RESOURCE_REGEX = /\bx?link:?href\s*=\s*["'](?!data:)[^"']+["']/i;
  function svgHasExternalResources(svg) {
    return SVG_EXTERNAL_RESOURCE_REGEX.test(svg.innerHTML);
  }
  async function domToForeignObjectSvg(node, options) {
    const context = await orCreateContext(node, options);
    if (isElementNode(context.node) && isSVGElementNode(context.node) && !svgHasExternalResources(context.node))
      return context.node;
    const {
      ownerDocument,
      log,
      tasks,
      svgStyleElement,
      svgDefsElement,
      svgStyles,
      font,
      progress,
      autoDestruct,
      onCloneNode,
      onEmbedNode,
      onCreateForeignObjectSvg
    } = context;
    log.time("clone node");
    const clone = await cloneNode(context.node, context, true);
    if (svgStyleElement && ownerDocument) {
      let allCssText = "";
      svgStyles.forEach((klasses, cssText) => {
        allCssText += `${klasses.join(",\n")} {
  ${cssText}
}
`;
      });
      svgStyleElement.appendChild(ownerDocument.createTextNode(allCssText));
    }
    log.timeEnd("clone node");
    await (onCloneNode == null ? void 0 : onCloneNode(clone));
    if (font !== false && isElementNode(clone)) {
      log.time("embed web font");
      await embedWebFont(clone, context);
      log.timeEnd("embed web font");
    }
    log.time("embed node");
    embedNode(clone, context);
    const count = tasks.length;
    let current = 0;
    const runTask = async () => {
      while (true) {
        const task = tasks.pop();
        if (!task)
          break;
        try {
          await task;
        } catch (error) {
          context.log.warn("Failed to run task", error);
        }
        progress == null ? void 0 : progress(++current, count);
      }
    };
    progress == null ? void 0 : progress(current, count);
    await Promise.all([...Array.from({ length: 4 })].map(runTask));
    log.timeEnd("embed node");
    await (onEmbedNode == null ? void 0 : onEmbedNode(clone));
    const svg = createForeignObjectSvg(clone, context);
    svgDefsElement && svg.insertBefore(svgDefsElement, svg.children[0]);
    svgStyleElement && svg.insertBefore(svgStyleElement, svg.children[0]);
    autoDestruct && destroyContext(context);
    await (onCreateForeignObjectSvg == null ? void 0 : onCreateForeignObjectSvg(svg));
    return svg;
  }
  function createForeignObjectSvg(clone, context) {
    const { width, height } = context;
    const svg = createSvg(width, height, clone.ownerDocument);
    const foreignObject = svg.ownerDocument.createElementNS(svg.namespaceURI, "foreignObject");
    foreignObject.setAttributeNS(null, "x", "0%");
    foreignObject.setAttributeNS(null, "y", "0%");
    foreignObject.setAttributeNS(null, "width", "100%");
    foreignObject.setAttributeNS(null, "height", "100%");
    foreignObject.append(clone);
    svg.appendChild(foreignObject);
    return svg;
  }
  async function domToCanvas(node, options) {
    var _a2;
    const context = await orCreateContext(node, options);
    const svg = await domToForeignObjectSvg(context);
    const dataUrl = svgToDataUrl(svg, context.isEnable("removeControlCharacter"));
    if (!context.autoDestruct) {
      context.svgStyleElement = createStyleElement(context.ownerDocument);
      context.svgDefsElement = (_a2 = context.ownerDocument) == null ? void 0 : _a2.createElementNS(XMLNS, "defs");
      context.svgStyles.clear();
    }
    const image = createImage(dataUrl, svg.ownerDocument);
    return await imageToCanvas(image, context);
  }

  // src/protocol.ts
  var PROTOCOL = "1";
  var PARENT_HANDSHAKE_PROTOCOL = "screenrig.parent-handshake/1";
  var CAPTURE_PROTOCOL = "screenrig.capture/1";
  var LIVENESS_PROTOCOL = "screenrig.liveness/1";
  var INPUT_PROTOCOL = "screenrig.input/1";
  var SIDE_CHANNEL_PROTOCOLS = [CAPTURE_PROTOCOL, LIVENESS_PROTOCOL, INPUT_PROTOCOL];
  var DEFAULT_PLAYER_ORIGIN = "https://play.screenrig.ai";
  var MAX_MESSAGE_BYTES = 65536;
  var MAX_LOG_MESSAGE_BYTES = 2048;
  var MAX_CLIENT_LOGS = 32;
  var MESSAGE_KINDS = [
    "context",
    "ready",
    "log",
    "event.emit",
    "page.advance",
    "page.skip",
    "viewport.changed",
    "kv.get",
    "kv.list",
    "kv.set",
    "kv.delete",
    "kv.watch",
    "kv.changed",
    "device.display",
    "device.watch",
    "device.vibrate",
    "device.event",
    "visibility.watch",
    "visibility.changed",
    "page.timing",
    "device.scanner.start",
    "device.scanner.stop",
    "device.serial.list",
    "device.serial.open",
    "device.serial.write",
    "device.serial.close",
    "device.gpio.write",
    "device.gpio.watch",
    "device.ble.read",
    "device.ble.watch",
    "device.ble.unwatch",
    "device.print",
    "device.printers",
    "response.ack",
    "response.problem"
  ];
  var BASELINE_FEATURES = [
    "context",
    "ready",
    "log",
    "event.emit",
    "page.advance",
    "viewport.changed",
    "kv.get",
    "kv.list",
    "kv.set",
    "kv.delete",
    "response.ack",
    "response.problem"
  ];
  var KIND_FEATURES = {
    "device.scanner.start": "device.camera",
    "device.scanner.stop": "device.camera",
    "device.serial.list": "device.serial",
    "device.serial.open": "device.serial",
    "device.serial.write": "device.serial",
    "device.serial.close": "device.serial",
    "device.gpio.write": "device.gpio",
    "device.gpio.watch": "device.gpio",
    "device.ble.read": "device.ble",
    "device.ble.watch": "device.ble",
    "device.ble.unwatch": "device.ble",
    "device.print": "device.print",
    "device.printers": "device.print"
  };
  function featureOf(kind) {
    return Object.prototype.hasOwnProperty.call(KIND_FEATURES, kind) ? KIND_FEATURES[kind] : kind;
  }
  var MAX_FEATURES = 64;
  var MAX_FEATURE_LENGTH = 64;
  var MAX_SKIP_REASON_CODE_POINTS = 64;
  var DEVICE_VIBRATE_MAX_MS = 200;
  var DEVICE_VIBRATE_DEFAULT_MS = 12;
  var DEVICE_WATCH_EVENTS = ["display", "presence", "keys", "light", "network", "scan", "people", "sound", "serial", "gpio", "ble"];
  var DEVICE_WATCH_NEEDS = {
    display: { capability: "device.display" },
    presence: { capability: "device.presence" },
    keys: { capability: "device.keys" },
    light: { capability: "device.light" },
    network: { capability: "device.network" },
    scan: { capability: "device.scan", feature: "device.scan" },
    people: { capability: "device.camera", feature: "device.camera" },
    sound: { capability: "device.sound", feature: "device.sound" },
    serial: { capability: "device.serial", feature: "device.serial" },
    gpio: { capability: "device.gpio", feature: "device.gpio" },
    ble: { capability: "device.ble", feature: "device.ble" }
  };
  var DEVICE_KEYS = ["volume_up", "volume_down"];
  var DEVICE_CHUNK_BYTES = 32768;
  var SCAN_FORMATS = ["qr", "ean13", "ean8", "upca", "upce", "code128", "code39", "code93", "itf", "codabar", "datamatrix", "pdf417", "aztec"];
  var SCAN_SOURCES = ["scanner", "nfc", "camera"];
  var MAX_SCAN_DATA_CHARS = 2048;
  var SCAN_FORMAT_RE = /^[a-z0-9_]{1,32}$/;
  var MAX_PEOPLE_COUNT = 1e3;
  var SOUND_MIN_DBFS = -120;
  var SERIAL_DATA_BITS = [5, 6, 7, 8];
  var SERIAL_STOP_BITS = [1, 2];
  var SERIAL_PARITIES = ["none", "even", "odd"];
  var SERIAL_FLOW_CONTROLS = ["none", "hardware"];
  var SERIAL_BAUD_MIN = 50;
  var SERIAL_BAUD_MAX = 4e6;
  var MAX_SERIAL_PORTS = 4;
  var MAX_SERIAL_LIST = 16;
  var MAX_SERIAL_WRITE_BYTES = 1048576;
  var SERIAL_BUFFER_BYTES = 65536;
  var SERIAL_CLOSE_REASONS = ["unplugged", "error"];
  var GPIO_PIN_MAX = 255;
  var GPIO_PULLS = ["up", "down", "none"];
  var MAX_GPIO_WATCH_PINS = 16;
  var MAX_BLE_VALUE_BYTES = 512;
  var MAX_BLE_SUBSCRIPTIONS = 8;
  var BLE_UUID_RE = /^(?:[0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  var MAX_BLE_DEVICE_CHARS = 64;
  var PRINT_FORMATS = ["escpos", "pdf"];
  var MAX_PRINT_BYTES = 4194304;
  var MAX_PRINTERS = 16;
  var HANDLE_RE = /^[A-Za-z0-9_-]{8,64}$/;
  var MAX_DEVICE_ID_CHARS = 128;
  var EMPTY_CAPABILITIES = {
    "page.advance": false,
    "page.skip": false,
    "kv.read": false,
    "kv.write": false,
    "device.display": false,
    "device.presence": false,
    "device.keys": false,
    "device.light": false,
    "device.network": false,
    "device.haptics": false,
    "device.scan": false,
    "device.camera": false,
    "device.sound": false,
    "device.serial": false,
    "device.gpio": false,
    "device.ble": false,
    "device.print": false
  };

  // src/capture.ts
  /*! Bundled modern-screenshot 4.7.0
  The MIT License (MIT)
  
  Copyright (c) 2021-present wxm
  
  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
  
  The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
  
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
  */
  var CAPTURE_MAX_BYTES = 2097152;
  var CAPTURE_TIMEOUT_MS = 5e3;
  var MAX_PIXELS = 8388608;
  var CaptureUnavailable = class extends Error {
    constructor(reason = "unsupported_surface") {
      super(reason);
      this.reason = reason;
    }
  };
  var frames = /* @__PURE__ */ new WeakMap();
  function boundedWebP(bytes) {
    if (bytes.length < 30 || String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") return false;
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    const u24 = (at) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
    let width = 0, height = 0;
    if (kind === "VP8X" && (bytes[20] & 2) === 0) {
      width = 1 + u24(24);
      height = 1 + u24(27);
    } else if (kind === "VP8L" && bytes[20] === 47) {
      width = 1 + (bytes[21] | (bytes[22] & 63) << 8);
      height = 1 + (bytes[22] >> 6 | bytes[23] << 2 | (bytes[24] & 15) << 10);
    } else if (kind === "VP8 " && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = (bytes[26] | bytes[27] << 8) & 16383;
      height = (bytes[28] | bytes[29] << 8) & 16383;
    }
    return width > 0 && height > 0 && width * height <= MAX_PIXELS;
  }
  function validCaptureRequest(value, context) {
    if (!context || !value || typeof value !== "object") return false;
    const request = value;
    if (Object.prototype.hasOwnProperty.call(request, "__proto__") || Object.prototype.hasOwnProperty.call(request, "constructor")) return false;
    return request.protocol === CAPTURE_PROTOCOL && request.kind === "capture" && request.primitive_id === context.primitive_id && request.generation === context.generation && request.nonce === context.nonce;
  }
  function attachCaptureReceiver(win, context) {
    let busy = false;
    const listener = (event) => {
      const binding = context();
      if (busy || event.source !== win.parent || event.origin === "null" || event.origin !== (binding == null ? void 0 : binding.player_origin) || !validCaptureRequest(event.data, binding) || event.ports.length !== 1) return;
      const port = event.ports[0];
      busy = true;
      void captureDOM(win.document.documentElement).then(async (canvas) => {
        const current = context();
        if ((current == null ? void 0 : current.nonce) !== binding.nonce || current.generation !== binding.generation) throw new CaptureUnavailable();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 1));
        if (!blob || blob.type !== "image/webp" || blob.size > CAPTURE_MAX_BYTES) throw new CaptureUnavailable("capture_failed");
        port.postMessage({ blob });
      }).catch(() => {
        port.postMessage({ unavailable: true });
      }).finally(() => {
        port.close();
        busy = false;
      });
    };
    win.addEventListener("message", listener);
    return () => win.removeEventListener("message", listener);
  }
  var BACKGROUND_LONGHANDS = [
    "background-attachment",
    "background-blend-mode",
    "background-clip",
    "background-color",
    "background-image",
    "background-origin",
    "background-position",
    "background-position-x",
    "background-position-y",
    "background-repeat",
    "background-size"
  ];
  function transparentColor(color) {
    var _a2;
    const value = color.trim().toLowerCase();
    if (value === "" || value === "transparent") return true;
    const alpha = (_a2 = /^rgba?\((?:[^,/)]+[,/\s]+){3}([\d.]+%?)\)$/.exec(value)) == null ? void 0 : _a2[1];
    return alpha !== void 0 && parseFloat(alpha) === 0;
  }
  function backgroundTransparent(style) {
    return transparentColor(style.backgroundColor) && (style.backgroundImage.trim() === "" || style.backgroundImage.trim() === "none");
  }
  function canvasBackgroundSource(html, body) {
    if (!backgroundTransparent(html)) return "html";
    return body !== void 0 && !backgroundTransparent(body) ? "body" : void 0;
  }
  function propagateCanvasBackground(source, html, body, height) {
    if (source === void 0) return;
    if (source === "body" && body !== void 0) {
      for (const property of BACKGROUND_LONGHANDS) {
        const value = body.getPropertyValue(property);
        if (value === "") continue;
        html.setProperty(property, value, body.getPropertyPriority(property));
        body.removeProperty(property);
      }
    }
    html.setProperty("min-height", `${height}px`);
  }
  function documentRootDisplay(computedDisplay) {
    return computedDisplay === "block" ? "flow-root" : void 0;
  }
  async function captureFrame(frame, signal) {
    var _a2;
    const binding = (_a2 = frames.get(frame)) == null ? void 0 : _a2();
    const child = frame.contentWindow;
    if (!binding || !child || binding.origin === "null" || binding.origin === "*") throw new CaptureUnavailable();
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const finish = (blob) => {
        clearTimeout(timer);
        signal == null ? void 0 : signal.removeEventListener("abort", abort);
        channel.port1.close();
        channel.port2.close();
        if (blob) resolve(blob);
        else reject(new CaptureUnavailable());
      };
      const abort = () => finish();
      const timer = setTimeout(abort, CAPTURE_TIMEOUT_MS);
      channel.port1.onmessage = (event) => {
        var _a3;
        const current = (_a3 = frames.get(frame)) == null ? void 0 : _a3();
        const data = event.data;
        if ((current == null ? void 0 : current.nonce) !== binding.nonce || current.generation !== binding.generation || !frame.isConnected) return finish();
        const blob = data == null ? void 0 : data.blob;
        finish(blob instanceof Blob && blob.type === "image/webp" && blob.size > 0 && blob.size <= CAPTURE_MAX_BYTES ? blob : void 0);
      };
      signal == null ? void 0 : signal.addEventListener("abort", abort, { once: true });
      if (signal == null ? void 0 : signal.aborted) return finish();
      try {
        child.postMessage({
          protocol: CAPTURE_PROTOCOL,
          kind: "capture",
          primitive_id: binding.primitive_id,
          generation: binding.generation,
          nonce: binding.nonce
        }, binding.origin, [channel.port2]);
      } catch {
        finish();
      }
    });
  }
  function visible(node) {
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  }
  async function captureFonts(document2, families) {
    var _a2;
    const rules = [];
    const visit = (list) => {
      for (const rule of list) {
        if (rule instanceof CSSFontFaceRule && families.has(rule.style.getPropertyValue("font-family").replace(/["']/g, "").toLowerCase())) rules.push(rule);
        else if (rule instanceof CSSImportRule && rule.styleSheet) visit(rule.styleSheet.cssRules);
        else if ("cssRules" in rule) visit(rule.cssRules);
      }
    };
    for (const sheet of document2.styleSheets) visit(sheet.cssRules);
    let total = 0;
    const output = [];
    for (const rule of rules) {
      let css = rule.cssText;
      const urls = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)];
      for (const match of urls) {
        const url = new URL(match[1], ((_a2 = rule.parentStyleSheet) == null ? void 0 : _a2.href) ?? document2.baseURI);
        if (url.origin !== document2.location.origin) throw new CaptureUnavailable();
        const buffer = await fetchFontBytes(url);
        total += buffer.byteLength;
        if (total > MAX_PIXELS) throw new CaptureUnavailable("capture_failed");
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
        css = css.replace(match[0], `url("data:font/ttf;base64,${btoa(binary)}")`);
      }
      output.push(css);
    }
    return output.join("\n") || "/* system fonts */";
  }
  var FONT_FETCH_TIMEOUT_MS = 2e3;
  async function fetchFontBytes(url, timeoutMs = FONT_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { credentials: "same-origin", cache: "force-cache", signal: controller.signal });
      if (!response.ok) throw new CaptureUnavailable("capture_failed");
      return await response.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }
  }
  async function drawBlobImage(url, budget) {
    if (!url.startsWith("blob:")) return false;
    const image = new Image();
    image.src = url;
    await image.decode();
    const pixels = image.naturalWidth * image.naturalHeight;
    if (pixels < 1) throw new CaptureUnavailable("capture_failed");
    const scale = Math.min(1, Math.sqrt(budget / pixels));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL();
  }
  function captureMarker() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `data-capture-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  var previous = Promise.resolve();
  function captureDOM(root, signal) {
    const result = previous.catch(() => void 0).then(() => capture(root, signal));
    previous = result;
    return result;
  }
  async function capture(root, signal) {
    if (signal == null ? void 0 : signal.aborted) throw new CaptureUnavailable();
    const width = root.clientWidth, height = root.clientHeight;
    if (width < 1 || height < 1 || width * height > MAX_PIXELS) throw new CaptureUnavailable("capture_failed");
    const marker = captureMarker();
    const replacements = /* @__PURE__ */ new Map();
    const marked = [];
    const videoClones = /* @__PURE__ */ new Map();
    const placeholders = [];
    const videos = /* @__PURE__ */ new WeakSet();
    const families = /* @__PURE__ */ new Set();
    let failed = false;
    const visit = async (node) => {
      if (!visible(node)) return;
      const style = getComputedStyle(node);
      for (const family of style.fontFamily.split(",")) families.add(family.trim().replace(/["']/g, "").toLowerCase());
      if (style.mixBlendMode !== "normal" || style.backdropFilter && style.backdropFilter !== "none") throw new CaptureUnavailable();
      if (node instanceof HTMLVideoElement) {
        if (node.readyState < 2 || node.videoWidth < 1 || node.videoHeight < 1) throw new CaptureUnavailable("capture_failed");
        const canvas = document.createElement("canvas");
        canvas.width = node.videoWidth;
        canvas.height = node.videoHeight;
        if (canvas.width * canvas.height > MAX_PIXELS) throw new CaptureUnavailable("capture_failed");
        canvas.getContext("2d").drawImage(node, 0, 0);
        const image = document.createElement("img");
        image.src = canvas.toDataURL();
        const key = `video-${placeholders.length}`;
        image.setAttribute(marker, key);
        image.style.display = "none";
        image.setAttribute("aria-hidden", "true");
        videoClones.set(key, Array.from(style).map((property) => `${property}:${style.getPropertyValue(property)};`).join(""));
        placeholders.push(image);
        videos.add(node);
        node.before(image);
        return;
      }
      if (node instanceof HTMLIFrameElement) {
        const blob = await captureFrame(node, signal);
        if (!boundedWebP(new Uint8Array(await blob.slice(0, 30).arrayBuffer()))) throw new CaptureUnavailable();
        const bitmap = await createImageBitmap(blob);
        try {
          if (bitmap.width * bitmap.height > MAX_PIXELS) throw new CaptureUnavailable();
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          const key = String(marked.length);
          replacements.set(key, canvas.toDataURL());
          node.setAttribute(marker, key);
          marked.push(node);
        } finally {
          bitmap.close();
        }
        return;
      }
      if (node instanceof HTMLObjectElement || node instanceof HTMLEmbedElement || node.shadowRoot) throw new CaptureUnavailable();
      for (const child of [...node.children]) await visit(child);
    };
    const owner = root.ownerDocument;
    const documentCapture = root === owner.documentElement;
    const canvasSource = documentCapture ? canvasBackgroundSource(getComputedStyle(root), owner.body ? getComputedStyle(owner.body) : void 0) : void 0;
    const rootDisplay = documentCapture ? documentRootDisplay(getComputedStyle(root).display) : void 0;
    let context;
    try {
      await visit(root);
      const fontCSS = await captureFonts(root.ownerDocument, families);
      context = await createContext(root, {
        width,
        height,
        scale: 1,
        timeout: 2e3,
        debug: false,
        font: { cssText: fontCSS },
        fetchFn: (url) => drawBlobImage(url, width * height),
        features: { restoreScrollPosition: true },
        filter: (node) => !videos.has(node) && (!(node instanceof Element) || node.hasAttribute(marker) || visible(node)),
        onCloneNode: (clone) => {
          if (!(clone instanceof Element)) return;
          if (rootDisplay !== void 0 && clone instanceof HTMLElement) clone.style.setProperty("display", rootDisplay);
          if (canvasSource !== void 0 && clone instanceof HTMLElement) {
            const body = Array.from(clone.children).find((child) => child instanceof HTMLElement && child.localName === "body");
            propagateCanvasBackground(canvasSource, clone.style, body == null ? void 0 : body.style, height);
          }
          for (const node of clone.querySelectorAll(`[${marker}]`)) {
            const key = node.getAttribute(marker);
            const videoStyle = videoClones.get(key);
            if (videoStyle !== void 0) {
              node.style.cssText = videoStyle;
              node.removeAttribute(marker);
              continue;
            }
            const image = document.createElement("img");
            image.src = replacements.get(key);
            image.style.cssText = node.style.cssText;
            image.style.objectFit = "fill";
            node.replaceWith(image);
          }
        }
      });
      context.log.warn = () => {
        failed = true;
      };
      const canvas = await domToCanvas(context);
      if (failed || (signal == null ? void 0 : signal.aborted)) throw new CaptureUnavailable("capture_failed");
      return canvas;
    } catch (error) {
      throw error instanceof CaptureUnavailable ? error : new CaptureUnavailable("capture_failed");
    } finally {
      for (const node of marked) node.removeAttribute(marker);
      for (const image of placeholders) image.remove();
      if (context) destroyContext(context);
    }
  }

  // src/liveness.ts
  function validLivenessRequest(value, context) {
    if (!context || !value || typeof value !== "object") return false;
    const request = value;
    if (Object.prototype.hasOwnProperty.call(request, "__proto__") || Object.prototype.hasOwnProperty.call(request, "constructor")) return false;
    return request.protocol === LIVENESS_PROTOCOL && request.kind === "ping" && request.primitive_id === context.primitive_id && request.generation === context.generation && request.nonce === context.nonce;
  }
  function attachLivenessReceiver(win, context) {
    const listener = (event) => {
      const binding = context();
      if (event.source !== win.parent || event.origin === "null" || event.origin !== (binding == null ? void 0 : binding.player_origin) || !validLivenessRequest(event.data, binding) || event.ports.length !== 1) return;
      const port = event.ports[0];
      try {
        port.postMessage({ protocol: LIVENESS_PROTOCOL, kind: "pong", generation: binding.generation, nonce: binding.nonce });
      } finally {
        port.close();
      }
    };
    win.addEventListener("message", listener);
    return () => win.removeEventListener("message", listener);
  }

  // src/input.ts
  function matches(value, kind, binding) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const message = value;
    return !Object.prototype.hasOwnProperty.call(message, "__proto__") && !Object.prototype.hasOwnProperty.call(message, "constructor") && message.protocol === INPUT_PROTOCOL && message.kind === kind && message.primitive_id === binding.primitive_id && message.generation === binding.generation && message.nonce === binding.nonce;
  }
  function attachInputReporter(win, doc, context) {
    let watched;
    const onMessage = (event) => {
      const current = context();
      if (!current || event.source !== win.parent || event.origin === "null" || event.origin !== current.player_origin || !matches(event.data, "watch", current)) return;
      watched = current;
    };
    const onInput = (event) => {
      const current = context();
      if (!event.isTrusted || !current || !watched || current.primitive_id !== watched.primitive_id || current.generation !== watched.generation || current.nonce !== watched.nonce || current.player_origin !== watched.player_origin) return;
      win.parent.postMessage({
        protocol: INPUT_PROTOCOL,
        kind: "input",
        primitive_id: current.primitive_id,
        generation: current.generation,
        nonce: current.nonce
      }, current.player_origin);
    };
    const events = ["pointerdown", "touchstart", "keydown", "wheel"];
    const options = { capture: true, passive: true };
    win.addEventListener("message", onMessage);
    for (const name of events) doc.addEventListener(name, onInput, options);
    return () => {
      watched = void 0;
      win.removeEventListener("message", onMessage);
      for (const name of events) doc.removeEventListener(name, onInput, options);
    };
  }

  // src/bytes.ts
  var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function encodeBase64(bytes) {
    let output = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index] ?? 0;
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const word = first << 16 | (second ?? 0) << 8 | (third ?? 0);
      output += ALPHABET[word >>> 18 & 63] ?? "";
      output += ALPHABET[word >>> 12 & 63] ?? "";
      output += second === void 0 ? "=" : ALPHABET[word >>> 6 & 63] ?? "";
      output += third === void 0 ? "=" : ALPHABET[word & 63] ?? "";
    }
    return output;
  }
  var DECODE = (() => {
    const table = new Int8Array(128).fill(-1);
    for (let index = 0; index < ALPHABET.length; index += 1) table[ALPHABET.charCodeAt(index)] = index;
    return table;
  })();
  function decodeBase64(text2, maxBytes = Number.MAX_SAFE_INTEGER) {
    if (text2.length % 4 !== 0) return void 0;
    const padding = text2.endsWith("==") ? 2 : text2.endsWith("=") ? 1 : 0;
    const length = text2.length / 4 * 3 - padding;
    if (length > maxBytes) return void 0;
    const output = new Uint8Array(length);
    let written = 0;
    for (let index = 0; index < text2.length; index += 4) {
      let word = 0;
      for (let offset = 0; offset < 4; offset += 1) {
        const code = text2.charCodeAt(index + offset);
        const isPad = code === 61;
        if (isPad) {
          if (index + 4 !== text2.length || offset < 4 - padding) return void 0;
          word <<= 6;
          continue;
        }
        const value = code < 128 ? DECODE[code] ?? -1 : -1;
        if (value < 0) return void 0;
        word = word << 6 | value;
      }
      for (const shift of [16, 8, 0]) {
        if (written < length) output[written++] = word >>> shift & 255;
      }
    }
    return output;
  }

  // src/validate.ts
  var SdkValidationError = class extends Error {
    code;
    constructor(code, message) {
      super(message);
      this.name = "SdkValidationError";
      this.code = code;
    }
  };
  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function utf8Bytes(value) {
    return new TextEncoder().encode(value).length;
  }
  function serializedSize(value) {
    try {
      return utf8Bytes(JSON.stringify(value));
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }
  var ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
  var PRIMITIVE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
  var NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;
  function isOpaqueOrigin(origin) {
    if (origin === "null") return true;
    try {
      return new URL(origin).origin === "null";
    } catch {
      return false;
    }
  }
  function isParentHandshakeCandidate(data) {
    return isRecord(data) && data.protocol === PARENT_HANDSHAKE_PROTOCOL && data.kind === "parent.handshake";
  }
  function hasForbiddenKeys(value) {
    return Object.prototype.hasOwnProperty.call(value, "__proto__") || Object.prototype.hasOwnProperty.call(value, "constructor");
  }
  function parseParentHandshakeOffer(data) {
    if (!isRecord(data) || serializedSize(data) > MAX_MESSAGE_BYTES) {
      throw new SdkValidationError("invalid_handshake", "Parent handshake must be a bounded object");
    }
    if (hasForbiddenKeys(data)) {
      throw new SdkValidationError("invalid_handshake", "Parent handshake contains forbidden keys");
    }
    if (data.protocol !== PARENT_HANDSHAKE_PROTOCOL || data.kind !== "parent.handshake" || typeof data.challenge !== "string" || !NONCE_RE.test(data.challenge)) {
      throw new SdkValidationError("invalid_handshake", "Parent handshake is invalid");
    }
    return { protocol: PARENT_HANDSHAKE_PROTOCOL, kind: "parent.handshake", challenge: data.challenge };
  }
  function isAllowedKind(kind) {
    return MESSAGE_KINDS.includes(kind);
  }
  function parseMessage(data) {
    if (typeof data === "string") {
      if (utf8Bytes(data) > MAX_MESSAGE_BYTES) {
        throw new SdkValidationError("message_too_large", "Message exceeds size limit");
      }
      try {
        data = JSON.parse(data);
      } catch {
        throw new SdkValidationError("invalid_json", "Message is not valid JSON");
      }
    }
    if (!isRecord(data)) {
      throw new SdkValidationError("invalid_shape", "Message must be an object");
    }
    if (hasForbiddenKeys(data)) {
      throw new SdkValidationError("invalid_shape", "Message contains forbidden keys");
    }
    if (serializedSize(data) > MAX_MESSAGE_BYTES) {
      throw new SdkValidationError("message_too_large", "Message exceeds size limit");
    }
    const protocol = data.protocol;
    const message_id = data.message_id;
    const kind = data.kind;
    const primitive_id = data.primitive_id;
    const payload = data.payload;
    if (protocol !== PROTOCOL) {
      throw new SdkValidationError("protocol_mismatch", "Unsupported protocol");
    }
    if (typeof message_id !== "string" || !ID_RE.test(message_id)) {
      throw new SdkValidationError("invalid_message_id", "Invalid message_id");
    }
    if (typeof kind !== "string" || kind.length === 0 || kind.length > 64) {
      throw new SdkValidationError("invalid_kind", "Invalid kind");
    }
    if (typeof primitive_id !== "string" || !PRIMITIVE_ID_RE.test(primitive_id)) {
      throw new SdkValidationError("invalid_primitive", "Invalid primitive_id");
    }
    if (!isRecord(payload) || hasForbiddenKeys(payload)) {
      throw new SdkValidationError("invalid_payload", "payload must be an object");
    }
    return { protocol, message_id, kind, primitive_id, payload };
  }
  function parseSize(value, name) {
    if (!isRecord(value)) {
      throw new SdkValidationError("invalid_context", `${name} must be an object`);
    }
    const width = value.width;
    const height = value.height;
    if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new SdkValidationError("invalid_context", `${name} width/height must be finite numbers`);
    }
    if (width < 0 || height < 0 || width > 1e5 || height > 1e5) {
      throw new SdkValidationError("invalid_context", `${name} dimensions out of range`);
    }
    return { width, height };
  }
  function parsePrimitiveSize(payload) {
    if (payload.primitive !== void 0) {
      try {
        return parseSize(payload.primitive, "primitive");
      } catch (err) {
        if (payload.placement === void 0) throw err;
      }
    }
    if (payload.placement !== void 0) {
      return parseSize(payload.placement, "placement");
    }
    throw new SdkValidationError("invalid_context", "primitive must be an object");
  }
  function readSize(value) {
    try {
      return parseSize(value, "size");
    } catch {
      return void 0;
    }
  }
  function parseFeatures(value) {
    if (!Array.isArray(value)) return void 0;
    const features = [];
    for (const entry of value.slice(0, MAX_FEATURES)) {
      if (typeof entry === "string" && entry.length > 0 && entry.length <= MAX_FEATURE_LENGTH && !features.includes(entry)) {
        features.push(entry);
      }
    }
    return features;
  }
  var CAPABILITY_NAMES = Object.keys(EMPTY_CAPABILITIES);
  function readCapabilities(source) {
    const capabilities = { ...EMPTY_CAPABILITIES };
    for (const name of CAPABILITY_NAMES) capabilities[name] = source[name] === true;
    return capabilities;
  }
  function parseCapabilities(value) {
    if (!isRecord(value)) {
      throw new SdkValidationError("invalid_context", "capabilities must be an object");
    }
    return readCapabilities(value);
  }
  var MAX_CONTEXT_PARAMS = 16;
  var MAX_CONTEXT_PARAM_VALUE = 512;
  var MAX_SCREEN_NAME = 200;
  var PARAM_NAME_RE = /^[a-z0-9_]{1,32}$/;
  var RESERVED_PARAMS = ["ticket", "policy"];
  var CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
  function codePoints(text2) {
    return text2.length <= 1 ? text2.length : Array.from(text2).length;
  }
  function parseContextParams(value, notes) {
    const params = {};
    if (value === void 0) return Object.freeze(params);
    if (!isRecord(value)) {
      notes == null ? void 0 : notes.push("invalid_params");
      return Object.freeze(params);
    }
    let kept = 0;
    let dropped = false;
    for (const name of Object.keys(value).sort()) {
      const entry = value[name];
      if (!PARAM_NAME_RE.test(name) || RESERVED_PARAMS.includes(name) || typeof entry !== "string" || codePoints(entry) > MAX_CONTEXT_PARAM_VALUE || kept >= MAX_CONTEXT_PARAMS) {
        dropped = true;
        continue;
      }
      Object.defineProperty(params, name, { value: entry, enumerable: true, writable: false, configurable: false });
      kept += 1;
    }
    if (dropped) notes == null ? void 0 : notes.push("invalid_params");
    return Object.freeze(params);
  }
  function isTimeZone(value) {
    if (value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch (err) {
      return !(err instanceof RangeError);
    }
  }
  function parseContextScreen(value, notes) {
    if (value === void 0) return void 0;
    if (!isRecord(value)) {
      notes == null ? void 0 : notes.push("invalid_screen");
      return void 0;
    }
    const screen = {};
    let dropped = false;
    const { name, timezone } = value;
    if (name !== void 0) {
      if (typeof name === "string" && name.length > 0 && codePoints(name) <= MAX_SCREEN_NAME && !CONTROL_RE.test(name)) screen.name = name;
      else dropped = true;
    }
    if (timezone !== void 0) {
      if (typeof timezone === "string" && isTimeZone(timezone)) screen.timezone = timezone;
      else dropped = true;
    }
    if (dropped) notes == null ? void 0 : notes.push("invalid_screen");
    return screen.name === void 0 && screen.timezone === void 0 ? void 0 : screen;
  }
  function parseContextPayload(payload, expectedOrigin, notes) {
    const application_id = payload.application_id;
    const release_id = payload.release_id;
    const primitive_id = payload.primitive_id;
    const generation = payload.generation;
    const nonce = payload.nonce;
    const player_origin = payload.player_origin;
    if (typeof application_id !== "string" || !ID_RE.test(application_id)) {
      throw new SdkValidationError("invalid_application", "Invalid application_id");
    }
    if (typeof release_id !== "string" || !ID_RE.test(release_id)) {
      throw new SdkValidationError("invalid_release", "Invalid release_id");
    }
    if (typeof primitive_id !== "string" || !PRIMITIVE_ID_RE.test(primitive_id)) {
      throw new SdkValidationError("invalid_primitive", "Invalid primitive_id");
    }
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0 || generation > Number.MAX_SAFE_INTEGER) {
      throw new SdkValidationError("invalid_generation", "Invalid generation");
    }
    if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      throw new SdkValidationError("invalid_nonce", "Invalid nonce");
    }
    if (typeof player_origin !== "string" || player_origin !== expectedOrigin) {
      throw new SdkValidationError("invalid_player_origin", "player_origin does not match the trusted player origin");
    }
    if (player_origin === "*" || expectedOrigin === "*") {
      throw new SdkValidationError("wildcard_origin", "Wildcard origins are not allowed");
    }
    const features = parseFeatures(payload.features);
    const params = parseContextParams(payload.params, notes);
    const screen = parseContextScreen(payload.screen, notes);
    return {
      application_id,
      release_id,
      primitive_id,
      generation,
      nonce,
      player_origin,
      capabilities: parseCapabilities(payload.capabilities),
      viewport: parseSize(payload.viewport, "viewport"),
      primitive: parsePrimitiveSize(payload),
      screen_id: typeof payload.screen_id === "string" && ID_RE.test(payload.screen_id) ? payload.screen_id : void 0,
      ...features === void 0 ? {} : { features },
      params,
      ...screen === void 0 ? {} : { screen }
    };
  }
  function parseResponseAckPayload(payload) {
    const requestMessageId = payload.request_message_id;
    const generation = payload.generation;
    const nonce = payload.nonce;
    if (typeof requestMessageId !== "string" || !ID_RE.test(requestMessageId) || typeof generation !== "number" || !Number.isSafeInteger(generation) || typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      throw new SdkValidationError("invalid_response", "Invalid response request_message_id");
    }
    return { request_message_id: requestMessageId, generation, nonce, result: payload.result };
  }
  function parseKvChangedPayload(payload) {
    const { key, revision, deleted, generation, nonce } = payload;
    if (typeof key !== "string" || new TextEncoder().encode(key).length < 1 || new TextEncoder().encode(key).length > 256 || typeof deleted !== "boolean" || typeof generation !== "number" || !Number.isSafeInteger(generation) || typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      throw new SdkValidationError("invalid_kv_change", "Invalid kv.changed payload");
    }
    if (revision !== void 0 && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) {
      throw new SdkValidationError("invalid_kv_change", "Invalid kv.changed revision");
    }
    return { key, deleted, generation, nonce, ...revision === void 0 || deleted ? {} : { revision } };
  }
  function isBrightness(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  }
  function parseDeviceDisplayRequest(state) {
    if (!isRecord(state)) {
      throw new SdkValidationError("invalid_request", "A display state is an object with on and brightness");
    }
    const request = {};
    for (const [member, value] of Object.entries(state)) {
      if (member !== "on" && member !== "brightness") {
        throw new SdkValidationError("invalid_request", `Unknown display member ${member}`);
      }
      if (value === void 0) continue;
      if (member === "on") {
        if (typeof value !== "boolean") throw new SdkValidationError("invalid_request", "on must be a boolean");
        request.on = value;
      } else {
        if (!isBrightness(value)) throw new SdkValidationError("invalid_request", "brightness must be a number from 0 to 1");
        request.brightness = value;
      }
    }
    return request;
  }
  function parseDeviceVibrateMs(ms) {
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 1 || ms > DEVICE_VIBRATE_MAX_MS) {
      throw new SdkValidationError("invalid_request", `ms must be an integer from 1 to ${DEVICE_VIBRATE_MAX_MS}`);
    }
    return ms;
  }
  function parseDeviceDisplayState(value, code = "invalid_response") {
    if (!isRecord(value) || typeof value.on !== "boolean") {
      throw new SdkValidationError(code, "Invalid display state");
    }
    const brightness = value.brightness === void 0 ? null : value.brightness;
    if (brightness !== null && !isBrightness(brightness)) {
      throw new SdkValidationError(code, "Invalid display brightness");
    }
    return { on: value.on, brightness };
  }
  function parseDeviceEventPayload(payload) {
    const { type, generation, nonce } = payload;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
      throw new SdkValidationError("invalid_device_event", "Invalid device.event binding");
    }
    if (type === "display") {
      const state = parseDeviceDisplayState(payload, "invalid_device_event");
      return { type, generation, nonce, ...state };
    }
    if (type === "presence") {
      return { type, generation, nonce };
    }
    if (type === "light") {
      const lux = payload.lux;
      if (typeof lux !== "number" || !Number.isFinite(lux) || lux < 0) {
        throw new SdkValidationError("invalid_device_event", "Invalid device.event lux");
      }
      return { type, generation, nonce, lux };
    }
    if (type === "network") {
      const online = payload.online;
      if (typeof online !== "boolean") throw new SdkValidationError("invalid_device_event", "Invalid device.event online");
      return { type, generation, nonce, online };
    }
    if (type === "key") {
      const key = payload.key;
      if (typeof key !== "string") throw new SdkValidationError("invalid_device_event", "Invalid device.event key");
      const known = DEVICE_KEYS.includes(key);
      return known ? { type, generation, nonce, key } : void 0;
    }
    return parseHardwareEvent(type, payload, generation, nonce);
  }
  function invalidEvent(what) {
    return new SdkValidationError("invalid_device_event", `Invalid device.event ${what}`);
  }
  function parseHardwareEvent(type, payload, generation, nonce) {
    if (type === "scan") {
      const { source, format, data } = payload;
      if (typeof source !== "string") throw invalidEvent("scan source");
      if (!SCAN_SOURCES.includes(source)) return void 0;
      if (typeof format !== "string" || !SCAN_FORMAT_RE.test(format)) throw invalidEvent("scan format");
      if (typeof data !== "string" || data.length === 0 || codePoints(data) > MAX_SCAN_DATA_CHARS) throw invalidEvent("scan data");
      return { type, generation, nonce, source, format, data };
    }
    if (type === "people") {
      const count = payload.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_PEOPLE_COUNT) throw invalidEvent("people count");
      return { type, generation, nonce, count };
    }
    if (type === "sound") {
      const dbfs = payload.dbfs;
      if (typeof dbfs !== "number" || !Number.isFinite(dbfs) || dbfs < SOUND_MIN_DBFS || dbfs > 0) throw invalidEvent("sound level");
      return { type, generation, nonce, dbfs };
    }
    if (type === "serial") {
      const { handle, data_base64: data, closed, reason } = payload;
      if (typeof handle !== "string" || !HANDLE_RE.test(handle)) throw invalidEvent("serial handle");
      if (closed !== void 0) {
        if (closed !== true || data !== void 0) throw invalidEvent("serial close");
        const known = typeof reason === "string" && SERIAL_CLOSE_REASONS.includes(reason);
        return { type, generation, nonce, handle, closed: true, ...known ? { reason } : {} };
      }
      const bytes = typeof data === "string" ? decodeBase64(data, DEVICE_CHUNK_BYTES) : void 0;
      if (bytes === void 0 || bytes.length === 0) throw invalidEvent("serial data");
      return { type, generation, nonce, handle, data_base64: data };
    }
    if (type === "gpio") {
      const { pin, value } = payload;
      if (typeof pin !== "number" || !Number.isInteger(pin) || pin < 0 || pin > GPIO_PIN_MAX || typeof value !== "boolean") throw invalidEvent("gpio level");
      return { type, generation, nonce, pin, value };
    }
    if (type === "ble") {
      const { subscription, value_base64: value } = payload;
      if (typeof subscription !== "string" || !HANDLE_RE.test(subscription)) throw invalidEvent("ble subscription");
      if (typeof value !== "string" || decodeBase64(value, MAX_BLE_VALUE_BYTES) === void 0) throw invalidEvent("ble value");
      return { type, generation, nonce, subscription, value_base64: value };
    }
    return void 0;
  }
  function parseVisibilityChangedPayload(payload) {
    const { visible: visible2, reason, generation, nonce } = payload;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || typeof nonce !== "string" || !NONCE_RE.test(nonce) || typeof visible2 !== "boolean" || typeof reason !== "string") {
      throw new SdkValidationError("invalid_visibility", "Invalid visibility.changed payload");
    }
    if (reason !== "display" && reason !== "paused" && reason !== "leaving") return void 0;
    if (visible2 && reason === "leaving") throw new SdkValidationError("invalid_visibility", "A page that is leaving is not visible");
    return { generation, nonce, visible: visible2, reason };
  }
  function parsePageTimingResult(value) {
    if (!isRecord(value)) throw new SdkValidationError("invalid_response", "Invalid page timing");
    const { elapsed_ms: elapsed, remaining_ms: remaining, paused } = value;
    const count = (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (!count(elapsed) || !(remaining === null || count(remaining)) || typeof paused !== "boolean") {
      throw new SdkValidationError("invalid_response", "Invalid page timing");
    }
    return { elapsedMs: elapsed, remainingMs: remaining, paused };
  }
  function invalidRequest(message) {
    return new SdkValidationError("invalid_request", message);
  }
  function onlyMembers(value, allowed, what) {
    for (const member of Object.keys(value)) {
      if (!allowed.includes(member)) throw invalidRequest(`Unknown ${what} member ${member}`);
    }
  }
  function isDeviceId(value) {
    return typeof value === "string" && value.length > 0 && codePoints(value) <= MAX_DEVICE_ID_CHARS && !CONTROL_RE.test(value);
  }
  function parseScannerOptions(options) {
    if (options === void 0) return {};
    if (!isRecord(options)) throw invalidRequest("Scanner options are an object with formats");
    onlyMembers(options, ["formats"], "scanner");
    const formats = options.formats;
    if (formats === void 0) return {};
    if (!Array.isArray(formats) || formats.length === 0 || formats.length > SCAN_FORMATS.length) throw invalidRequest("formats is a list of 1 to 13 symbologies");
    const seen = [];
    for (const format of formats) {
      if (typeof format !== "string" || !SCAN_FORMATS.includes(format) || seen.includes(format)) {
        throw invalidRequest("formats lists each known symbology once");
      }
      seen.push(format);
    }
    return { formats: seen };
  }
  function parseScannerStartResult(value) {
    if (!isRecord(value) || !Array.isArray(value.formats)) throw new SdkValidationError("invalid_response", "Invalid scanner state");
    return { formats: value.formats.filter((format) => typeof format === "string" && SCAN_FORMATS.includes(format)) };
  }
  function parseSerialPortId(port) {
    if (!isDeviceId(port)) throw invalidRequest(`A serial port is a name of 1 to ${MAX_DEVICE_ID_CHARS} characters`);
    return port;
  }
  function oneOf(value, allowed, member) {
    if (!allowed.includes(value)) throw invalidRequest(`${member} is one of ${allowed.join(", ")}`);
    return value;
  }
  function parseSerialOptions(options) {
    if (!isRecord(options)) throw invalidRequest("Serial options are an object with baudRate");
    onlyMembers(options, ["baudRate", "dataBits", "stopBits", "parity", "flowControl"], "serial");
    const baud = options.baudRate;
    if (typeof baud !== "number" || !Number.isInteger(baud) || baud < SERIAL_BAUD_MIN || baud > SERIAL_BAUD_MAX) {
      throw invalidRequest(`baudRate is an integer from ${SERIAL_BAUD_MIN} to ${SERIAL_BAUD_MAX}`);
    }
    const out = { baud_rate: baud };
    if (options.dataBits !== void 0) out.data_bits = oneOf(options.dataBits, SERIAL_DATA_BITS, "dataBits");
    if (options.stopBits !== void 0) out.stop_bits = oneOf(options.stopBits, SERIAL_STOP_BITS, "stopBits");
    if (options.parity !== void 0) out.parity = oneOf(options.parity, SERIAL_PARITIES, "parity");
    if (options.flowControl !== void 0) out.flow_control = oneOf(options.flowControl, SERIAL_FLOW_CONTROLS, "flowControl");
    return out;
  }
  function parseSerialWriteData(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : void 0;
    if (bytes === void 0) throw invalidRequest("Serial data is a Uint8Array or a string");
    if (bytes.length === 0 || bytes.length > MAX_SERIAL_WRITE_BYTES) throw invalidRequest(`Serial data is 1 to ${MAX_SERIAL_WRITE_BYTES} bytes`);
    return bytes;
  }
  function readPortInfo(value) {
    if (!isRecord(value) || !isDeviceId(value.id)) return void 0;
    const id = value.id;
    const name = typeof value.name === "string" && value.name.length > 0 && !CONTROL_RE.test(value.name) ? value.name.slice(0, 200) : id;
    const usb = (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65535;
    return { id, name, ...usb(value.vendor_id) ? { vendorId: value.vendor_id } : {}, ...usb(value.product_id) ? { productId: value.product_id } : {} };
  }
  function parseSerialListResult(value) {
    if (!isRecord(value) || !Array.isArray(value.ports)) throw new SdkValidationError("invalid_response", "Invalid serial port list");
    const ports = [];
    for (const entry of value.ports) {
      const port = readPortInfo(entry);
      if (port !== void 0 && ports.length < MAX_SERIAL_LIST) ports.push(port);
    }
    return ports;
  }
  function parseHandleResult(value, member) {
    const handle = isRecord(value) ? value[member] : void 0;
    if (typeof handle !== "string" || !HANDLE_RE.test(handle)) throw new SdkValidationError("invalid_response", `Invalid ${member}`);
    return handle;
  }
  function parseGpioPin(pin) {
    if (typeof pin !== "number" || !Number.isInteger(pin) || pin < 0 || pin > GPIO_PIN_MAX) throw invalidRequest(`pin is an integer from 0 to ${GPIO_PIN_MAX}`);
    return pin;
  }
  function parseGpioValue(value) {
    if (typeof value !== "boolean") throw invalidRequest("value is a boolean");
    return value;
  }
  function ownMember(value, member) {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, member) ? value[member] : void 0;
  }
  function parseGpioWriteOptions(options) {
    if (options === void 0) return {};
    if (!isRecord(options)) throw invalidRequest("GPIO write options are an object with idle");
    onlyMembers(options, ["idle"], "GPIO write");
    const idle = ownMember(options, "idle");
    if (idle === void 0) return {};
    if (typeof idle !== "boolean") throw invalidRequest("idle is a boolean");
    return { idle };
  }
  function parseGpioChangeOptions(options) {
    if (options === void 0) return {};
    if (!isRecord(options)) throw invalidRequest("GPIO input options are an object with pull");
    onlyMembers(options, ["pull"], "GPIO input");
    const pull = ownMember(options, "pull");
    if (pull === void 0) return {};
    if (typeof pull !== "string" || !GPIO_PULLS.includes(pull)) throw invalidRequest(`pull is one of ${GPIO_PULLS.join(", ")}`);
    return { pull };
  }
  function parseBleTarget(target) {
    if (!isRecord(target)) throw invalidRequest("A BLE target is an object with service and characteristic");
    onlyMembers(target, ["service", "characteristic", "device"], "BLE");
    const uuid3 = (value, member) => {
      const text2 = typeof value === "string" ? value.toLowerCase() : "";
      if (!BLE_UUID_RE.test(text2)) throw invalidRequest(`${member} is a UUID of 4, 8 or 36 hexadecimal characters`);
      return text2;
    };
    const service = uuid3(target.service, "service");
    const characteristic = uuid3(target.characteristic, "characteristic");
    const device = target.device;
    if (device === void 0) return { service, characteristic };
    if (typeof device !== "string" || device.length === 0 || codePoints(device) > MAX_BLE_DEVICE_CHARS || CONTROL_RE.test(device)) {
      throw invalidRequest(`device is a name or address of 1 to ${MAX_BLE_DEVICE_CHARS} characters`);
    }
    return { service, characteristic, device };
  }
  function parseBleReadResult(value) {
    const bytes = isRecord(value) && typeof value.value_base64 === "string" ? decodeBase64(value.value_base64, MAX_BLE_VALUE_BYTES) : void 0;
    if (bytes === void 0) throw new SdkValidationError("invalid_response", "Invalid BLE value");
    return bytes;
  }
  function parsePrintJob(job) {
    if (!isRecord(job)) throw invalidRequest("A print job is an object with escpos or pdf");
    onlyMembers(job, ["escpos", "pdf", "printer"], "print job");
    const { escpos, pdf, printer } = job;
    if (escpos === void 0 === (pdf === void 0)) throw invalidRequest("A print job has exactly one of escpos and pdf");
    const bytes = escpos === void 0 ? pdf : escpos;
    if (!(bytes instanceof Uint8Array)) throw invalidRequest("escpos and pdf are Uint8Array");
    if (bytes.length === 0 || bytes.length > MAX_PRINT_BYTES) throw invalidRequest(`A print job is 1 to ${MAX_PRINT_BYTES} bytes`);
    if (printer !== void 0 && !isDeviceId(printer)) throw invalidRequest(`printer is an id of 1 to ${MAX_DEVICE_ID_CHARS} characters`);
    const format = escpos === void 0 ? "pdf" : "escpos";
    return { format, bytes, ...printer === void 0 ? {} : { printer } };
  }
  function parsePrintersResult(value) {
    if (!isRecord(value) || !Array.isArray(value.printers)) throw new SdkValidationError("invalid_response", "Invalid printer list");
    const printers = [];
    for (const entry of value.printers) {
      if (!isRecord(entry) || !isDeviceId(entry.id) || !Array.isArray(entry.formats)) continue;
      const formats = entry.formats.filter((format) => PRINT_FORMATS.includes(format));
      const name = typeof entry.name === "string" && entry.name.length > 0 && !CONTROL_RE.test(entry.name) ? entry.name.slice(0, 200) : entry.id;
      if (printers.length < MAX_PRINTERS) printers.push({ id: entry.id, name, formats, ...entry.default === true ? { default: true } : {} });
    }
    return printers;
  }
  function parseResponseProblemPayload(payload) {
    const requestMessageId = payload.request_message_id;
    const generation = payload.generation;
    const nonce = payload.nonce;
    const problem = payload.problem;
    if (typeof requestMessageId !== "string" || !ID_RE.test(requestMessageId) || typeof generation !== "number" || !Number.isSafeInteger(generation) || typeof nonce !== "string" || !NONCE_RE.test(nonce) || !isRecord(problem)) {
      throw new SdkValidationError("invalid_response", "Invalid problem response envelope");
    }
    if (typeof problem.code !== "string" || typeof problem.status !== "number" || !Number.isInteger(problem.status) || typeof problem.detail !== "string" || typeof problem.request_id !== "string") {
      throw new SdkValidationError("invalid_response", "Invalid problem response payload");
    }
    const currentRevision = problem.current_revision;
    if (currentRevision !== void 0 && (typeof currentRevision !== "number" || !Number.isInteger(currentRevision))) {
      throw new SdkValidationError("invalid_response", "Invalid problem current_revision");
    }
    return {
      request_message_id: requestMessageId,
      generation,
      nonce,
      problem: {
        code: problem.code,
        status: problem.status,
        detail: problem.detail,
        request_id: problem.request_id,
        ...currentRevision === void 0 ? {} : { current_revision: currentRevision }
      }
    };
  }
  function assertTrustedOrigin(origin, trusted) {
    if (!origin || origin === "*" || trusted.length === 0 || trusted.some((value) => !value || value === "*")) {
      throw new SdkValidationError("wildcard_origin", "Wildcard origins are not allowed");
    }
    if (!trusted.includes(origin)) {
      throw new SdkValidationError("untrusted_origin", "Message origin is not the trusted player");
    }
  }
  function negotiateCapabilities(offered) {
    return readCapabilities(offered);
  }
  function sanitizeSkipReason(reason) {
    const cleaned = reason.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
    const clipped = Array.from(cleaned).slice(0, MAX_SKIP_REASON_CODE_POINTS).join("").trim();
    return clipped === "" ? void 0 : clipped;
  }

  // src/hardware.ts
  var SCANNER_START = { features: ["device.camera", "device.scan"], capabilities: ["device.camera", "device.scan"] };
  var CAMERA = { features: ["device.camera"], capabilities: ["device.camera"] };
  var SERIAL = { features: ["device.serial"], capabilities: ["device.serial"] };
  var GPIO = { features: ["device.gpio"], capabilities: ["device.gpio"] };
  var GPIO_IDLE = { features: ["device.gpio", "device.gpio.idle"], capabilities: ["device.gpio"] };
  var BLE = { features: ["device.ble"], capabilities: ["device.ble"] };
  var PRINT = { features: ["device.print"], capabilities: ["device.print"] };
  function enqueue(queue, run) {
    const idle = queue.active === 0;
    queue.active += 1;
    const job = async () => {
      try {
        return await run();
      } finally {
        queue.active -= 1;
      }
    };
    const result = idle || queue.tail === null ? job() : queue.tail.then(job, job);
    queue.tail = result.then(() => void 0, () => void 0);
    return result;
  }
  function chunksOf(bytes) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += DEVICE_CHUNK_BYTES) chunks.push(bytes.subarray(offset, offset + DEVICE_CHUNK_BYTES));
    return chunks;
  }
  var DeviceHardware = class {
    constructor(bridge) {
      this.bridge = bridge;
    }
    scanHandlers = /* @__PURE__ */ new Set();
    peopleHandlers = /* @__PURE__ */ new Set();
    soundHandlers = /* @__PURE__ */ new Set();
    ports = /* @__PURE__ */ new Map();
    pendingPorts = 0;
    /** Per watched line, its handlers and the pull each asked for (a pin's handlers all ask for the same). */
    gpioHandlers = /* @__PURE__ */ new Map();
    /** The context and pins (with the pull each carried) device.gpio.watch last carried; a new context sends it again. */
    gpioSent = null;
    /** The context a `gpio_pull_unsupported` warning was last logged for: one per context. */
    gpioPullWarned = null;
    bleSubscriptions = /* @__PURE__ */ new Map();
    pendingBle = 0;
    printing = { tail: null, active: 0 };
    scanner = {
      start: (options) => this.scannerStart(options),
      stop: () => this.scannerStop()
    };
    serial = {
      list: () => this.serialList(),
      open: (port, options) => this.serialOpen(port, options)
    };
    gpio = {
      write: (pin, value, options) => this.gpioWrite(pin, value, options),
      onChange: (pin, handler, options) => this.gpioOnChange(pin, handler, options)
    };
    ble = {
      read: (target) => this.bleRead(target),
      watch: (target, handler) => this.bleWatch(target, handler)
    };
    onScan(handler) {
      return this.bridge.on("onScan", this.scanHandlers, handler);
    }
    onPeople(handler) {
      return this.bridge.on("onPeople", this.peopleHandlers, handler);
    }
    onSoundLevel(handler) {
      return this.bridge.on("onSoundLevel", this.soundHandlers, handler);
    }
    /** Whether a hardware event type has a reason to be watched now. */
    wants(event) {
      switch (event) {
        case "scan":
          return this.scanHandlers.size > 0;
        case "people":
          return this.peopleHandlers.size > 0;
        case "sound":
          return this.soundHandlers.size > 0;
        case "serial":
          return this.ports.size + this.pendingPorts > 0;
        case "gpio":
          return this.gpioHandlers.size > 0;
        case "ble":
          return this.bleSubscriptions.size + this.pendingBle > 0;
      }
    }
    // ---- camera ---------------------------------------------------------------
    async scannerStart(options) {
      this.bridge.check(SCANNER_START);
      const members = parseScannerOptions(options);
      return parseScannerStartResult(await this.bridge.send("device.scanner.start", members));
    }
    async scannerStop() {
      this.bridge.check(CAMERA);
      await this.bridge.send("device.scanner.stop", {});
    }
    // ---- serial ---------------------------------------------------------------
    async serialList() {
      this.bridge.check(SERIAL);
      return parseSerialListResult(await this.bridge.send("device.serial.list", {}));
    }
    async serialOpen(port, options) {
      this.bridge.check(SERIAL);
      const id = parseSerialPortId(port);
      const line = parseSerialOptions(options);
      if (this.ports.size + this.pendingPorts >= MAX_SERIAL_PORTS) {
        throw new SdkValidationError("port_limit", `At most ${MAX_SERIAL_PORTS} serial ports are open at once`);
      }
      this.pendingPorts += 1;
      this.bridge.watchChanged();
      let handle;
      try {
        handle = parseHandleResult(await this.bridge.send("device.serial.open", { port: id, ...line }), "handle");
      } catch (err) {
        this.pendingPorts -= 1;
        this.bridge.watchChanged();
        throw err;
      }
      this.pendingPorts -= 1;
      const state = { id, handle, open: true, writing: { tail: null, active: 0 }, data: /* @__PURE__ */ new Set(), close: /* @__PURE__ */ new Set(), buffered: [], bufferedBytes: 0 };
      this.ports.set(handle, state);
      this.bridge.watchChanged();
      return this.portApi(state);
    }
    portApi(state) {
      const api = {
        id: state.id,
        write: (data) => this.serialWrite(state, data),
        onData: (handler) => {
          if (typeof handler !== "function") throw new SdkValidationError("invalid_handler", "port.onData needs a function");
          state.data.add(handler);
          const held = state.buffered;
          state.buffered = [];
          state.bufferedBytes = 0;
          for (const bytes of held) this.callPort(() => handler(bytes));
          return () => {
            state.data.delete(handler);
          };
        },
        onClose: (handler) => {
          if (typeof handler !== "function") throw new SdkValidationError("invalid_handler", "port.onClose needs a function");
          state.close.add(handler);
          return () => {
            state.close.delete(handler);
          };
        },
        close: () => this.serialClose(state)
      };
      return Object.freeze(api);
    }
    serialWrite(state, data) {
      const run = async () => {
        this.bridge.check(SERIAL);
        const bytes = parseSerialWriteData(data);
        for (const chunk of chunksOf(bytes)) {
          if (!state.open) throw new SdkValidationError("invalid_handle", "The serial port is closed");
          await this.bridge.send("device.serial.write", { handle: state.handle, data_base64: encodeBase64(chunk) });
        }
      };
      return enqueue(state.writing, run);
    }
    async serialClose(state) {
      if (!state.open) return;
      state.open = false;
      state.data.clear();
      state.close.clear();
      this.ports.delete(state.handle);
      try {
        await this.bridge.send("device.serial.close", { handle: state.handle });
      } finally {
        this.bridge.watchChanged();
      }
    }
    callPort(invoke) {
      try {
        invoke();
      } catch {
        this.bridge.report("warn", "device_handler", "A screenrig.device serial handler threw");
      }
    }
    serialData(handle, bytes) {
      const state = this.ports.get(handle);
      if (state === void 0) return;
      if (state.data.size === 0) {
        state.buffered.push(bytes);
        state.bufferedBytes += bytes.length;
        while (state.bufferedBytes > SERIAL_BUFFER_BYTES && state.buffered.length > 0) {
          const excess = state.bufferedBytes - SERIAL_BUFFER_BYTES;
          const oldest = state.buffered[0];
          if (oldest.length <= excess) {
            state.buffered.shift();
            state.bufferedBytes -= oldest.length;
          } else {
            state.buffered[0] = oldest.subarray(excess);
            state.bufferedBytes -= excess;
          }
        }
        return;
      }
      for (const handler of [...state.data]) this.callPort(() => handler(bytes.slice()));
    }
    serialClosed(handle, reason) {
      const state = this.ports.get(handle);
      if (state === void 0) return;
      state.open = false;
      this.ports.delete(handle);
      const handlers = [...state.close];
      state.data.clear();
      state.close.clear();
      for (const handler of handlers) this.callPort(() => handler(reason));
      this.bridge.watchChanged();
    }
    // ---- GPIO -----------------------------------------------------------------
    async gpioWrite(pin, value, options) {
      this.bridge.check(ownMember(options, "idle") !== void 0 ? GPIO_IDLE : GPIO);
      const members = { pin: parseGpioPin(pin), value: parseGpioValue(value), ...parseGpioWriteOptions(options) };
      await this.bridge.send("device.gpio.write", members);
    }
    gpioOnChange(pin, handler, options) {
      if (typeof handler !== "function") throw new SdkValidationError("invalid_handler", "device.gpio.onChange needs a function");
      const line = parseGpioPin(pin);
      const pull = parseGpioChangeOptions(options).pull;
      if (!this.gpioHandlers.has(line) && this.gpioHandlers.size >= MAX_GPIO_WATCH_PINS) {
        throw new SdkValidationError("invalid_request", `At most ${MAX_GPIO_WATCH_PINS} GPIO lines are watched at once`);
      }
      const handlers = this.gpioHandlers.get(line) ?? /* @__PURE__ */ new Map();
      if (pull !== void 0) {
        for (const asked of handlers.values()) {
          if (asked !== void 0 && asked !== pull) throw new SdkValidationError("invalid_request", `GPIO line ${line} is already watched with pull ${asked}, not ${pull}`);
        }
      }
      handlers.set(handler, pull);
      this.gpioHandlers.set(line, handlers);
      this.bridge.watchChanged();
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0 && this.gpioHandlers.get(line) === handlers) this.gpioHandlers.delete(line);
        this.bridge.watchChanged();
      };
    }
    /** The pull a pin's handlers name ("none" when none names one). */
    gpioPull(line) {
      var _a2;
      for (const asked of ((_a2 = this.gpioHandlers.get(line)) == null ? void 0 : _a2.values()) ?? []) if (asked !== void 0) return asked;
      return "none";
    }
    /**
     * Called by the client after it settled `device.watch`. `device.gpio.watch`
     * follows `device.watch` and carries the full set of lines, and their pull
     * when the host can bias an input; a watch without `gpio` ends the host's set,
     * so nothing is sent for that.
     */
    afterWatch(events, bound) {
      const pins = events.includes("gpio") ? [...this.gpioHandlers.keys()].sort((a, b) => a - b) : [];
      const biased = pins.filter((line) => this.gpioPull(line) !== "none");
      const canBias = this.bridge.supports("device.gpio.pull");
      if (biased.length > 0 && !canBias && this.gpioPullWarned !== bound) {
        this.gpioPullWarned = bound;
        this.bridge.report("warn", "gpio_pull_unsupported", `The Player cannot set a pull on GPIO line ${biased.join(", ")}: watching it without one. Add an external resistor.`);
      }
      const pull = {};
      if (canBias) for (const line of biased) pull[String(line)] = this.gpioPull(line);
      const key = pins.map((line) => `${line}${pull[String(line)] === void 0 ? "" : `:${pull[String(line)]}`}`).join(",");
      const previous2 = this.gpioSent !== null && this.gpioSent.bound === bound ? this.gpioSent.pins : "";
      this.gpioSent = { bound, pins: key };
      if (key === previous2 || pins.length === 0) return;
      const members = { pins, ...Object.keys(pull).length > 0 ? { pull } : {} };
      this.bridge.send("device.gpio.watch", members).catch((err) => {
        this.bridge.report("warn", "gpio_watch", `device.gpio.watch failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    // ---- Bluetooth LE ---------------------------------------------------------
    async bleRead(target) {
      this.bridge.check(BLE);
      const members = parseBleTarget(target);
      return parseBleReadResult(await this.bridge.send("device.ble.read", members));
    }
    async bleWatch(target, handler) {
      this.bridge.check(BLE);
      if (typeof handler !== "function") throw new SdkValidationError("invalid_handler", "device.ble.watch needs a function");
      const members = parseBleTarget(target);
      if (this.bleSubscriptions.size + this.pendingBle >= MAX_BLE_SUBSCRIPTIONS) {
        throw new SdkValidationError("subscription_limit", `At most ${MAX_BLE_SUBSCRIPTIONS} BLE subscriptions are held at once`);
      }
      this.pendingBle += 1;
      this.bridge.watchChanged();
      let subscription;
      try {
        subscription = parseHandleResult(await this.bridge.send("device.ble.watch", members), "subscription");
      } catch (err) {
        this.pendingBle -= 1;
        this.bridge.watchChanged();
        throw err;
      }
      this.pendingBle -= 1;
      this.bleSubscriptions.set(subscription, handler);
      this.bridge.watchChanged();
      return () => {
        if (!this.bleSubscriptions.delete(subscription)) return;
        this.bridge.send("device.ble.unwatch", { subscription }).catch((err) => {
          this.bridge.report("warn", "ble_unwatch", `device.ble.unwatch failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        this.bridge.watchChanged();
      };
    }
    // ---- printing -------------------------------------------------------------
    async printers() {
      this.bridge.check(PRINT);
      return parsePrintersResult(await this.bridge.send("device.printers", {}));
    }
    print(job) {
      const run = async () => {
        this.bridge.check(PRINT);
        const { format, bytes, printer } = parsePrintJob(job);
        const id = this.bridge.newId();
        const chunks = chunksOf(bytes);
        for (const [seq, chunk] of chunks.entries()) {
          const members = { job: id, seq, last: seq === chunks.length - 1, data_base64: encodeBase64(chunk) };
          if (seq === 0) {
            members.format = format;
            members.total_bytes = bytes.length;
            if (printer !== void 0) members.printer = printer;
          }
          await this.bridge.send("device.print", members);
        }
      };
      return enqueue(this.printing, run);
    }
    // ---- host events ----------------------------------------------------------
    /** Delivers one hardware `device.event` to its handlers. */
    dispatch(event) {
      var _a2;
      const call = (invoke) => {
        try {
          invoke();
        } catch {
          this.bridge.report("warn", "device_handler", "A screenrig.device handler threw");
        }
      };
      switch (event.type) {
        case "scan":
          for (const handler of [...this.scanHandlers]) call(() => handler({ source: event.source, format: event.format, data: event.data }));
          return;
        case "people":
          for (const handler of [...this.peopleHandlers]) call(() => handler(event.count));
          return;
        case "sound":
          for (const handler of [...this.soundHandlers]) call(() => handler(event.dbfs));
          return;
        case "serial": {
          if ("closed" in event) {
            this.serialClosed(event.handle, event.reason ?? "error");
            return;
          }
          const bytes = decodeBase64(event.data_base64, DEVICE_CHUNK_BYTES);
          if (bytes !== void 0) this.serialData(event.handle, bytes);
          return;
        }
        case "gpio":
          for (const handler of [...((_a2 = this.gpioHandlers.get(event.pin)) == null ? void 0 : _a2.keys()) ?? []]) call(() => handler(event.value));
          return;
        case "ble": {
          const handler = this.bleSubscriptions.get(event.subscription);
          const bytes = handler === void 0 ? void 0 : decodeBase64(event.value_base64, 512);
          if (handler !== void 0 && bytes !== void 0) call(() => handler(bytes));
          return;
        }
        default:
          return;
      }
    }
    /**
     * A frame's context ended: ports, subscriptions and the host's pin set end with
     * it. A new context starts with none, so each is gone here and a port's
     * `onClose` handlers hear `context`. GPIO handlers stay: they are re-sent with
     * the new context's watch.
     */
    reset(notify) {
      const ports = [...this.ports.values()];
      this.ports.clear();
      for (const state of ports) {
        state.open = false;
        const handlers = [...state.close];
        state.data.clear();
        state.close.clear();
        if (notify) for (const handler of handlers) this.callPort(() => handler("context"));
      }
      this.bleSubscriptions.clear();
      this.gpioSent = null;
      this.gpioPullWarned = null;
    }
    /** The SDK was destroyed: drop every handler. */
    destroy() {
      this.reset(false);
      this.scanHandlers.clear();
      this.peopleHandlers.clear();
      this.soundHandlers.clear();
      this.gpioHandlers.clear();
    }
  };

  // src/screenrig.ts
  function randomId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `msg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  function randomIdempotencyKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }
  var MAX_FORWARDED_ERRORS = 10;
  function isSideChannelMessage(data) {
    return typeof data === "object" && data !== null && SIDE_CHANNEL_PROTOCOLS.includes(data.protocol);
  }
  var ScreenRigClient = class {
    constructor(options, allowOpaqueNativeParent = false, nativeParentOrigin) {
      this.nativeParentOrigin = nativeParentOrigin;
      var _a2, _b;
      this.host = options.host;
      this.trustedPlayerOrigins = options.trustedPlayerOrigins ?? [options.trustedPlayerOrigin ?? DEFAULT_PLAYER_ORIGIN];
      if (this.trustedPlayerOrigins.length === 0 || this.trustedPlayerOrigins.some((origin) => !origin || origin === "*")) {
        throw new SdkValidationError("wildcard_origin", "Wildcard origins are not allowed");
      }
      this.idFactory = options.idFactory ?? randomId;
      this.ackTimeoutMs = options.ackTimeoutMs ?? 1e4;
      this.allowOpaqueNativeParent = allowOpaqueNativeParent;
      this.unsubscribe = this.host.addMessageListener((event) => this.onMessage(event));
      this.unsubscribeErrors = (_b = (_a2 = this.host).addErrorListener) == null ? void 0 : _b.call(_a2, (error) => this.forwardError(error));
    }
    readyState = "inert";
    context = null;
    capabilities = { ...EMPTY_CAPABILITIES };
    host;
    trustedPlayerOrigins;
    idFactory;
    ackTimeoutMs;
    allowOpaqueNativeParent;
    destroyed = false;
    activeWaiters = /* @__PURE__ */ new Set();
    pending = /* @__PURE__ */ new Map();
    resizeHandlers = /* @__PURE__ */ new Set();
    capabilityHandlers = /* @__PURE__ */ new Set();
    kvChangeHandlers = /* @__PURE__ */ new Set();
    /** The context (generation and nonce) kv.watch was last sent under; a new context sends it again. */
    watchedContext = null;
    visibilityHandlers = /* @__PURE__ */ new Set();
    /** The context visibility.watch was last sent under; a new context sends it again. */
    visibilityWatched = null;
    /** Uncaught errors forwarded this activation (at most MAX_FORWARDED_ERRORS). */
    forwardedErrors = 0;
    /**
     * The generation and nonce of the context in force. A `context` message with
     * another binding is a new context and ends what the last one held; one with
     * the same binding only refreshes capabilities, features and sizes.
     */
    activeBinding = null;
    deviceHandlers = {
      display: /* @__PURE__ */ new Set(),
      presence: /* @__PURE__ */ new Set(),
      keys: /* @__PURE__ */ new Set(),
      light: /* @__PURE__ */ new Set(),
      network: /* @__PURE__ */ new Set()
    };
    /** The context and event types device.watch last carried; a new context sends it again. */
    deviceWatched = null;
    unsubscribe;
    unsubscribeErrors;
    advanced = false;
    /** `ready()` was called for this activation: a skip is no longer a start-time decision. */
    readied = false;
    reports = 0;
    parentOrigin = null;
    targetOrigin = null;
    handshakeChallenge = null;
    opaqueSourceBound = false;
    kv = {
      get: (key) => this.kvGet(key),
      getText: (key) => this.kvGetText(key),
      getJSON: (key) => this.kvGetJSON(key),
      list: () => this.kvList(),
      set: (key, value, options) => this.kvSet(key, value, options),
      setJSON: (key, value, options) => this.kvSetJSON(key, value, options),
      delete: (key, expectedRevision, options) => this.kvDelete(key, expectedRevision, options),
      onChange: (handler) => this.kvOnChange(handler)
    };
    hardware = new DeviceHardware({
      check: (needs) => this.checkDevice(needs),
      send: (kind, members) => this.sendDevice(kind, members),
      on: (name, handlers, handler) => this.deviceOn(name, handlers, handler),
      supports: (feature) => this.supports(feature),
      watchChanged: () => this.watchDevice(),
      report: (level, code, message) => this.report(level, code, message),
      newId: () => this.idFactory()
    });
    device = {
      display: {
        get: () => this.deviceDisplay(void 0),
        set: (state) => this.deviceDisplay(state)
      },
      onDisplay: (handler) => this.deviceOn("onDisplay", this.deviceHandlers.display, handler),
      onPresence: (handler) => this.deviceOn("onPresence", this.deviceHandlers.presence, handler),
      onKey: (handler) => this.deviceOn("onKey", this.deviceHandlers.keys, handler),
      onLight: (handler) => this.deviceOn("onLight", this.deviceHandlers.light, handler),
      onNetwork: (handler) => this.deviceOn("onNetwork", this.deviceHandlers.network, handler),
      vibrate: (ms) => this.deviceVibrate(ms),
      onScan: (handler) => this.hardware.onScan(handler),
      scanner: this.hardware.scanner,
      onPeople: (handler) => this.hardware.onPeople(handler),
      onSoundLevel: (handler) => this.hardware.onSoundLevel(handler),
      serial: this.hardware.serial,
      gpio: this.hardware.gpio,
      ble: this.hardware.ble,
      print: (job) => this.hardware.print(job),
      printers: () => this.hardware.printers()
    };
    destroy() {
      var _a2;
      this.destroyed = true;
      this.unsubscribe();
      (_a2 = this.unsubscribeErrors) == null ? void 0 : _a2.call(this);
      this.unsubscribeErrors = void 0;
      for (const waiter of this.activeWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new SdkValidationError("destroyed", "SDK was destroyed before activation"));
      }
      this.activeWaiters.clear();
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new SdkValidationError("destroyed", "SDK was destroyed before the parent acknowledged the request"));
      }
      this.pending.clear();
      this.kvChangeHandlers.clear();
      this.watchedContext = null;
      this.deviceHandlers.display.clear();
      this.deviceHandlers.presence.clear();
      this.deviceHandlers.keys.clear();
      this.deviceHandlers.light.clear();
      this.deviceHandlers.network.clear();
      this.deviceWatched = null;
      this.hardware.destroy();
      this.activeBinding = null;
      this.visibilityHandlers.clear();
      this.visibilityWatched = null;
      this.readied = false;
      this.readyState = "inert";
      this.context = null;
      this.parentOrigin = null;
      this.targetOrigin = null;
      this.handshakeChallenge = null;
      this.opaqueSourceBound = false;
    }
    onMessage(event) {
      try {
        if (event.source !== this.host.parent) {
          this.report("debug", "ignored_source", "Ignored message from non-parent source");
          return;
        }
        if (isSideChannelMessage(event.data)) return;
        if (isParentHandshakeCandidate(event.data)) {
          this.acceptParentHandshake(event);
          return;
        }
        if (this.parentOrigin === null || event.origin !== this.parentOrigin) {
          this.report("debug", "unbound_parent", "Ignored message before a valid parent handshake");
          return;
        }
        const message = parseMessage(event.data);
        if (!isAllowedKind(message.kind)) {
          this.report("debug", "ignored_kind", "Ignored unknown message kind");
          return;
        }
        if (message.kind === "context") {
          this.acceptContext(message);
          return;
        }
        if (this.readyState !== "active" || !this.context) {
          this.report("debug", "inert", "Ignored message while SDK is inert");
          return;
        }
        if (message.primitive_id !== this.context.primitive_id) {
          this.report("debug", "stale_primitive", "Ignored message for another primitive");
          return;
        }
        if (message.kind === "response.ack" || message.kind === "response.problem") {
          if (message.kind === "response.problem") {
            const response = parseResponseProblemPayload(message.payload);
            if (!this.matchesRuntime(response.generation, response.nonce)) return;
            const waiter = this.pending.get(response.request_message_id);
            if (!waiter) return;
            this.pending.delete(response.request_message_id);
            clearTimeout(waiter.timer);
            const problem = response.problem;
            waiter.reject(new SdkValidationError(problem.code, `${problem.detail} (request_id: ${problem.request_id})`));
          } else {
            const response = parseResponseAckPayload(message.payload);
            if (!this.matchesRuntime(response.generation, response.nonce)) return;
            const waiter = this.pending.get(response.request_message_id);
            if (!waiter) return;
            this.pending.delete(response.request_message_id);
            clearTimeout(waiter.timer);
            waiter.resolve(response.result);
          }
          return;
        }
        if (message.kind === "viewport.changed") {
          if (!this.matchesRuntime(message.payload.generation, message.payload.nonce)) return;
          const viewport = readSize(message.payload.viewport);
          const primitive = readSize(message.payload.primitive) ?? readSize(message.payload.placement);
          if (!viewport || !primitive) {
            return;
          }
          this.context = { ...this.context, viewport, primitive };
          for (const handler of this.resizeHandlers) {
            handler({ viewport, primitive });
          }
          return;
        }
        if (message.kind === "kv.changed") {
          const change = parseKvChangedPayload(message.payload);
          if (!this.matchesRuntime(change.generation, change.nonce)) return;
          const delivered = { key: change.key, deleted: change.deleted, ...change.revision === void 0 ? {} : { revision: change.revision } };
          for (const handler of [...this.kvChangeHandlers]) {
            try {
              handler({ ...delivered });
            } catch {
              this.report("warn", "kv_change_handler", "A kv.onChange handler threw");
            }
          }
          return;
        }
        if (message.kind === "device.event") {
          const event2 = parseDeviceEventPayload(message.payload);
          if (event2 === void 0 || !this.matchesRuntime(event2.generation, event2.nonce)) return;
          this.dispatchDeviceEvent(event2);
          return;
        }
        if (message.kind === "visibility.changed") {
          const change = parseVisibilityChangedPayload(message.payload);
          if (change === void 0 || !this.matchesRuntime(change.generation, change.nonce)) return;
          for (const handler of [...this.visibilityHandlers]) {
            try {
              handler({ visible: change.visible, reason: change.reason });
            } catch {
              this.report("warn", "visibility_handler", "A screenrig.onVisibility handler threw");
            }
          }
          return;
        }
      } catch (err) {
        if (err instanceof SdkValidationError && err.code === "wildcard_origin") {
          this.readyState = "failed";
        }
        this.report("debug", "ignored_invalid", "Ignored invalid parent message");
      }
    }
    acceptParentHandshake(event) {
      const offer = parseParentHandshakeOffer(event.data);
      if (this.handshakeChallenge !== null) {
        return;
      }
      const opaque = isOpaqueOrigin(event.origin);
      if (event.origin === this.nativeParentOrigin) {
      } else if (opaque) {
        if (!this.allowOpaqueNativeParent) {
          throw new SdkValidationError("untrusted_origin", "Opaque parent is not allowed for this application origin");
        }
      } else {
        assertTrustedOrigin(event.origin, this.trustedPlayerOrigins);
      }
      this.parentOrigin = event.origin;
      this.targetOrigin = opaque ? "*" : event.origin;
      this.handshakeChallenge = offer.challenge;
      this.opaqueSourceBound = opaque;
      this.host.postToParent(
        {
          protocol: PARENT_HANDSHAKE_PROTOCOL,
          kind: "child.handshake",
          challenge: offer.challenge,
          parent_origin: event.origin
        },
        this.targetOrigin,
        this.opaqueSourceBound
      );
    }
    acceptContext(message) {
      if (this.parentOrigin === null || this.handshakeChallenge === null) {
        throw new SdkValidationError("invalid_handshake", "Context arrived before the parent handshake");
      }
      const notes = [];
      const context = parseContextPayload(message.payload, this.parentOrigin, notes);
      if (context.nonce !== this.handshakeChallenge) {
        throw new SdkValidationError("invalid_nonce", "Context nonce does not match the parent challenge");
      }
      if (message.primitive_id !== context.primitive_id) {
        throw new SdkValidationError("invalid_primitive", "Envelope primitive_id does not match payload");
      }
      this.context = context;
      this.capabilities = negotiateCapabilities(context.capabilities);
      this.readyState = "active";
      for (const waiter of this.activeWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.activeWaiters.clear();
      this.advanced = false;
      this.readied = false;
      const binding = `${context.generation}:${context.nonce}`;
      if (binding !== this.activeBinding) {
        this.activeBinding = binding;
        this.forwardedErrors = 0;
        this.hardware.reset(true);
      }
      for (const note of notes) {
        this.report("debug", note, note === "invalid_params" ? "Dropped invalid launch params from the context" : "Dropped an invalid screen from the context");
      }
      for (const handler of this.capabilityHandlers) {
        handler(this.capabilities);
      }
      this.watchKv();
      this.watchVisibility();
      this.watchDevice();
    }
    supports(kind) {
      var _a2;
      const features = ((_a2 = this.context) == null ? void 0 : _a2.features) ?? BASELINE_FEATURES;
      return features.includes(kind);
    }
    post(message, wait) {
      if (this.targetOrigin === null || this.handshakeChallenge === null) {
        throw new SdkValidationError("inert", "SDK has not bound a parent handshake");
      }
      if (!this.supports(featureOf(message.kind))) {
        if (!wait) return Promise.resolve(void 0);
        return Promise.reject(new SdkValidationError("not_supported", `The Player does not support ${message.kind}`));
      }
      if (!wait) {
        this.host.postToParent(message, this.targetOrigin, this.opaqueSourceBound);
        return Promise.resolve(void 0);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(message.message_id);
          reject(new SdkValidationError("ack_timeout", `Parent did not acknowledge ${message.kind}`));
        }, this.ackTimeoutMs);
        this.pending.set(message.message_id, { resolve, reject, timer });
        try {
          this.host.postToParent(message, this.targetOrigin, this.opaqueSourceBound);
        } catch (err) {
          clearTimeout(timer);
          this.pending.delete(message.message_id);
          reject(err);
        }
      });
    }
    matchesRuntime(generation, nonce) {
      return this.context !== null && generation === this.context.generation && nonce === this.context.nonce;
    }
    report(level, code, message) {
      this.reports += 1;
      if (this.reports > MAX_CLIENT_LOGS || this.readyState === "inert") {
        return;
      }
      try {
        this.log({ level, code, message });
      } catch {
      }
    }
    requireActive() {
      if (this.readyState !== "active" || !this.context) {
        throw new SdkValidationError("inert", "SDK is inert until it validates the parent challenge and matching context");
      }
      return this.context;
    }
    /** Wait for the authenticated parent context, without declaring the app rendered. */
    waitUntilActive(timeoutMs = 1e4) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3e5) {
        return Promise.reject(new SdkValidationError("invalid_timeout", "Activation timeout must be between 1 and 300000 milliseconds"));
      }
      if (this.destroyed) return Promise.reject(new SdkValidationError("destroyed", "SDK was destroyed"));
      if (this.readyState === "active") return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: setTimeout(() => {
          this.activeWaiters.delete(waiter);
          reject(new SdkValidationError("activation_timeout", "Parent context did not become active"));
        }, timeoutMs) };
        this.activeWaiters.add(waiter);
      });
    }
    async ready() {
      const context = this.requireActive();
      this.readied = true;
      await this.post(
        {
          protocol: PROTOCOL,
          message_id: this.idFactory(),
          kind: "ready",
          primitive_id: context.primitive_id,
          payload: { generation: context.generation, nonce: context.nonce }
        },
        true
      );
    }
    log(entry) {
      const context = this.requireActive();
      const level = entry.level;
      if (level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
        throw new SdkValidationError("invalid_log", "Invalid log level");
      }
      const code = entry.code.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
      const message = entry.message.slice(0, MAX_LOG_MESSAGE_BYTES);
      void this.post(
        {
          protocol: PROTOCOL,
          message_id: this.idFactory(),
          kind: "log",
          primitive_id: context.primitive_id,
          payload: { level, code, message, generation: context.generation, nonce: context.nonce }
        },
        false
      );
    }
    emit(code) {
      void this.emitEvent(code, false);
    }
    /** Resolves only when the parent confirms backend acceptance, not merely local send. */
    async emitConfirmed(code) {
      await this.emitEvent(code, true);
    }
    emitEvent(code, confirmed) {
      const context = this.requireActive();
      const sanitized = code.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
      if (!sanitized) {
        throw new SdkValidationError("invalid_event", "Invalid event code");
      }
      return this.post(
        {
          protocol: PROTOCOL,
          message_id: this.idFactory(),
          kind: "event.emit",
          primitive_id: context.primitive_id,
          payload: { code: sanitized, generation: context.generation, nonce: context.nonce }
        },
        confirmed
      );
    }
    async nextPage() {
      const context = this.requireActive();
      if (!this.capabilities["page.advance"]) {
        throw new SdkValidationError("capability_denied", "This primitive cannot advance the page");
      }
      if (this.advanced) {
        this.report("debug", "advance_one_shot", "nextPage already used for this activation");
        return;
      }
      this.advanced = true;
      try {
        await this.post(
          {
            protocol: PROTOCOL,
            message_id: this.idFactory(),
            kind: "page.advance",
            primitive_id: context.primitive_id,
            payload: { generation: context.generation, nonce: context.nonce }
          },
          true
        );
      } catch (err) {
        this.advanced = false;
        throw err;
      }
    }
    async skip(reason) {
      const context = this.requireActive();
      if (!this.supports("page.skip")) {
        throw new SdkValidationError("not_supported", "The Player does not support page.skip");
      }
      if (!this.capabilities["page.skip"]) {
        throw new SdkValidationError("capability_denied", "This primitive cannot skip the page");
      }
      if (this.readied) {
        throw new SdkValidationError("skip_after_ready", "skip() is a start-time decision: call it instead of ready()");
      }
      const cleaned = typeof reason === "string" ? sanitizeSkipReason(reason) : void 0;
      const payload = { generation: context.generation, nonce: context.nonce, ...cleaned === void 0 ? {} : { reason: cleaned } };
      await this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "page.skip", primitive_id: context.primitive_id, payload: { ...payload } }, true);
    }
    requireKey(key) {
      const bytes = new TextEncoder().encode(key);
      if (bytes.length < 1 || bytes.length > 256 || key.startsWith("_screenrig/")) {
        throw new SdkValidationError("invalid_key", "K/V key must be 1-256 UTF-8 bytes and not use _screenrig/");
      }
      return key;
    }
    requireCapability(capability) {
      const context = this.requireActive();
      if (!this.capabilities[capability]) {
        throw new SdkValidationError("capability_denied", `This primitive does not have ${capability}`);
      }
      return context;
    }
    async kvGet(key) {
      const context = this.requireCapability("kv.read");
      const payload = { key: this.requireKey(key), generation: context.generation, nonce: context.nonce };
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.get", primitive_id: context.primitive_id, payload: { ...payload } }, true);
    }
    async kvGetText(key) {
      const entry = await this.kvGet(key);
      const bytes = typeof (entry == null ? void 0 : entry.value_base64) === "string" ? decodeBase64(entry.value_base64) : void 0;
      if (bytes === void 0) throw new SdkValidationError("invalid_response", "The stored value is not base64");
      return new TextDecoder().decode(bytes);
    }
    async kvGetJSON(key) {
      const text2 = await this.kvGetText(key);
      try {
        return JSON.parse(text2);
      } catch {
        throw new SdkValidationError("invalid_value", "The stored value is not JSON");
      }
    }
    kvSetJSON(key, value, options = {}) {
      let text2;
      try {
        text2 = JSON.stringify(value);
      } catch {
        text2 = void 0;
      }
      if (typeof text2 !== "string") {
        return Promise.reject(new SdkValidationError("invalid_value", "K/V value must be representable as JSON"));
      }
      return this.kvSet(key, text2, { ...options, contentType: options.contentType ?? "application/json" });
    }
    async kvList() {
      const context = this.requireCapability("kv.read");
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.list", primitive_id: context.primitive_id, payload: { generation: context.generation, nonce: context.nonce } }, true);
    }
    async kvSet(key, value, options = {}) {
      const context = this.requireCapability("kv.write");
      if (typeof value !== "string" && !(value instanceof Uint8Array)) {
        throw new SdkValidationError("invalid_value", "K/V value must be a string or a Uint8Array; serialize other values first (for example JSON.stringify)");
      }
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const payload = {
        key: this.requireKey(key),
        value_base64: encodeBase64(bytes),
        content_type: options.contentType ?? (typeof value === "string" ? "text/plain" : "application/octet-stream"),
        idempotency_key: options.idempotencyKey ?? randomIdempotencyKey(),
        generation: context.generation,
        nonce: context.nonce,
        ...options.expectedRevision === void 0 ? {} : { expected_revision: options.expectedRevision }
      };
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.set", primitive_id: context.primitive_id, payload: { ...payload } }, true);
    }
    async kvDelete(key, expectedRevision, options = {}) {
      const context = this.requireCapability("kv.write");
      if (expectedRevision !== void 0 && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
        throw new SdkValidationError("invalid_revision", "expectedRevision must be a non-negative integer");
      }
      const payload = {
        key: this.requireKey(key),
        ...expectedRevision === void 0 ? {} : { expected_revision: expectedRevision },
        idempotency_key: options.idempotencyKey ?? randomIdempotencyKey(),
        generation: context.generation,
        nonce: context.nonce
      };
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.delete", primitive_id: context.primitive_id, payload: { ...payload } }, true);
    }
    kvOnChange(handler) {
      if (typeof handler !== "function") {
        throw new SdkValidationError("invalid_handler", "kv.onChange needs a function");
      }
      this.kvChangeHandlers.add(handler);
      this.watchKv();
      return () => {
        this.kvChangeHandlers.delete(handler);
      };
    }
    /**
     * kv.watch is a notification sent once per context while a handler exists:
     * the host then posts kv.changed for this application's keys to this frame.
     */
    watchKv() {
      const context = this.context;
      const bound = context ? `${context.generation}:${context.nonce}` : null;
      if (this.readyState !== "active" || !context || this.kvChangeHandlers.size === 0 || this.watchedContext === bound) return;
      if (!this.capabilities["kv.read"] || !this.supports("kv.watch")) return;
      this.watchedContext = bound;
      void this.post(
        {
          protocol: PROTOCOL,
          message_id: this.idFactory(),
          kind: "kv.watch",
          primitive_id: context.primitive_id,
          payload: { generation: context.generation, nonce: context.nonce }
        },
        false
      );
    }
    async deviceDisplay(state) {
      const context = this.requireActive();
      if (!this.supports("device.display")) {
        throw new SdkValidationError("not_supported", "The Player does not support device.display");
      }
      if (!this.capabilities["device.display"]) {
        throw new SdkValidationError("capability_denied", "This primitive does not have device.display");
      }
      const members = state === void 0 ? {} : parseDeviceDisplayRequest(state);
      const payload = { generation: context.generation, nonce: context.nonce, ...members };
      const result = await this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "device.display", primitive_id: context.primitive_id, payload: { ...payload } }, true);
      return parseDeviceDisplayState(result);
    }
    async deviceVibrate(ms) {
      const context = this.requireActive();
      if (!this.supports("device.vibrate")) {
        throw new SdkValidationError("not_supported", "The Player does not support device.vibrate");
      }
      if (!this.capabilities["device.haptics"]) {
        throw new SdkValidationError("capability_denied", "This primitive does not have device.haptics");
      }
      const payload = { generation: context.generation, nonce: context.nonce, ms: parseDeviceVibrateMs(ms === void 0 ? DEVICE_VIBRATE_DEFAULT_MS : ms) };
      await this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "device.vibrate", primitive_id: context.primitive_id, payload: { ...payload } }, true);
    }
    /**
     * Registers a device handler, as kv.onChange registers one: it throws only for
     * a non-function, works before activation, and stays quiet without the
     * capability or the Player's support, where the handler never runs.
     */
    deviceOn(name, handlers, handler) {
      if (typeof handler !== "function") {
        throw new SdkValidationError("invalid_handler", `device.${name} needs a function`);
      }
      handlers.add(handler);
      this.watchDevice();
      return () => {
        handlers.delete(handler);
        this.watchDevice();
      };
    }
    dispatchDeviceEvent(event) {
      const call = (invoke) => {
        try {
          invoke();
        } catch {
          this.report("warn", "device_handler", "A screenrig.device handler threw");
        }
      };
      if (event.type === "display") {
        for (const handler of [...this.deviceHandlers.display]) call(() => handler({ on: event.on, brightness: event.brightness }));
      } else if (event.type === "presence") {
        for (const handler of [...this.deviceHandlers.presence]) call(() => handler());
      } else if (event.type === "light") {
        for (const handler of [...this.deviceHandlers.light]) call(() => handler(event.lux));
      } else if (event.type === "network") {
        for (const handler of [...this.deviceHandlers.network]) call(() => handler(event.online));
      } else if (event.type === "key") {
        for (const handler of [...this.deviceHandlers.keys]) call(() => handler(event.key));
      } else {
        this.hardware.dispatch(event);
      }
    }
    /** Whether some handler wants this event type now. */
    wantsDeviceEvent(event) {
      switch (event) {
        case "display":
        case "presence":
        case "keys":
        case "light":
        case "network":
          return this.deviceHandlers[event].size > 0;
        default:
          return this.hardware.wants(event);
      }
    }
    /**
     * The device event types this frame can watch now: a handler exists, the
     * context holds the capability, and the host advertises device.watch (and, for
     * a hardware event, the feature of that device).
     */
    deviceWatchEvents() {
      if (!this.supports("device.watch")) return [];
      return DEVICE_WATCH_EVENTS.filter((event) => {
        const needs = DEVICE_WATCH_NEEDS[event];
        return this.wantsDeviceEvent(event) && this.capabilities[needs.capability] && (needs.feature === void 0 || this.supports(needs.feature));
      });
    }
    /**
     * device.watch carries the full set of event types the frame wants and each
     * send replaces the previous one. It is sent whenever that set changes and
     * again for a new context, which starts with no subscription; `[]` stops.
     */
    watchDevice() {
      const context = this.context;
      if (this.readyState !== "active" || !context) return;
      const bound = `${context.generation}:${context.nonce}`;
      const events = this.deviceWatchEvents();
      const key = events.join(",");
      const previous2 = this.deviceWatched !== null && this.deviceWatched.bound === bound ? this.deviceWatched.events : "";
      this.deviceWatched = { bound, events: key };
      if (key !== previous2) {
        const payload = { generation: context.generation, nonce: context.nonce, events };
        void this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "device.watch", primitive_id: context.primitive_id, payload: { ...payload } }, false);
      }
      this.hardware.afterWatch(events, bound);
    }
    /** Throws `inert`, `not_supported` or `capability_denied` for a hardware call, in that order. */
    checkDevice(needs) {
      this.requireActive();
      for (const feature of needs.features) {
        if (!this.supports(feature)) throw new SdkValidationError("not_supported", `The Player does not support ${feature}`);
      }
      for (const capability of needs.capabilities) {
        if (!this.capabilities[capability]) throw new SdkValidationError("capability_denied", `This primitive does not have ${capability}`);
      }
    }
    /** Posts a request bound to the current context and resolves with its ack's result. */
    sendDevice(kind, members) {
      const context = this.requireActive();
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind, primitive_id: context.primitive_id, payload: { ...members, generation: context.generation, nonce: context.nonce } }, true);
    }
    // ---- visibility, timing, uncaught errors -----------------------------------
    onVisibility(handler) {
      if (typeof handler !== "function") {
        throw new SdkValidationError("invalid_handler", "onVisibility needs a function");
      }
      this.visibilityHandlers.add(handler);
      this.watchVisibility();
      return () => {
        this.visibilityHandlers.delete(handler);
      };
    }
    /**
     * visibility.watch is a notification sent once per context while a handler
     * exists, as kv.watch is: the host then posts visibility.changed to this frame.
     */
    watchVisibility() {
      const context = this.context;
      const bound = context ? `${context.generation}:${context.nonce}` : null;
      if (this.readyState !== "active" || !context || this.visibilityHandlers.size === 0 || this.visibilityWatched === bound) return;
      if (!this.supports("visibility.watch")) return;
      this.visibilityWatched = bound;
      void this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "visibility.watch", primitive_id: context.primitive_id, payload: { generation: context.generation, nonce: context.nonce } }, false);
    }
    async pageTiming() {
      const context = this.requireActive();
      const result = await this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "page.timing", primitive_id: context.primitive_id, payload: { generation: context.generation, nonce: context.nonce } }, true);
      return parsePageTimingResult(result);
    }
    /**
     * An uncaught error or unhandled rejection becomes a `log` entry while the
     * runtime is active: level error, at most MAX_FORWARDED_ERRORS per activation,
     * and counted in the client's report cap. It never touches the event.
     */
    forwardError(error) {
      if (this.readyState !== "active" || this.forwardedErrors >= MAX_FORWARDED_ERRORS) return;
      this.forwardedErrors += 1;
      const location = error.file === void 0 ? "" : ` (${error.file}${error.line === void 0 ? "" : `:${error.line}${error.column === void 0 ? "" : `:${error.column}`}`})`;
      const code = error.kind === "error" ? "uncaught_error" : "unhandled_rejection";
      const head = error.message.slice(0, Math.max(0, MAX_LOG_MESSAGE_BYTES - location.length));
      this.report("error", code, `${head}${location}`);
    }
    onResize(handler) {
      this.resizeHandlers.add(handler);
      return () => this.resizeHandlers.delete(handler);
    }
    onCapabilities(handler) {
      this.capabilityHandlers.add(handler);
      return () => this.capabilityHandlers.delete(handler);
    }
  };
  function createAttachedScreenRig(options, allowOpaqueNativeParent, nativeParentOrigin) {
    return new ScreenRigClient(options, allowOpaqueNativeParent, nativeParentOrigin);
  }

  // src/host.ts
  function text(value) {
    return typeof value === "string" && value.length > 0 ? value : void 0;
  }
  function position(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
  }
  function readErrorEvent(event) {
    const source = event;
    if (typeof source !== "object" || source === null || typeof source.message !== "string") return void 0;
    const file = text(source.filename);
    const line = position(source.lineno);
    const column = position(source.colno);
    return { kind: "error", message: source.message, ...file === void 0 ? {} : { file }, ...line === void 0 ? {} : { line }, ...column === void 0 ? {} : { column } };
  }
  function stackLocation(stack) {
    if (typeof stack !== "string") return void 0;
    const match = /(?:\(|@|at\s+)([^\s()@]+?):(\d+):(\d+)\)?\s*$/m.exec(stack);
    return match ? { file: match[1], line: Number(match[2]), column: Number(match[3]) } : void 0;
  }
  function readRejectionEvent(event) {
    const source = event;
    if (typeof source !== "object" || source === null || !("reason" in source)) return void 0;
    const reason = source.reason;
    let message;
    if (reason instanceof Error) message = reason.message || reason.name;
    else if (typeof reason === "string") message = reason;
    else {
      try {
        message = JSON.stringify(reason) ?? String(reason);
      } catch {
        message = String(reason);
      }
    }
    const where = reason instanceof Error ? stackLocation(reason.stack) : void 0;
    return { kind: "unhandledrejection", message, ...where === void 0 ? {} : where };
  }
  var BrowserHost = class {
    constructor(windowLike) {
      this.windowLike = windowLike;
      this.parent = windowLike.parent;
    }
    parent;
    addMessageListener(listener) {
      const wrapped = (event) => listener(event);
      this.windowLike.addEventListener("message", wrapped);
      return () => this.windowLike.removeEventListener("message", wrapped);
    }
    /**
     * `error` and `unhandledrejection` of the window. The listeners only read the
     * event: they never call preventDefault, so the browser's console report and
     * the page's own handlers are untouched. An event of another shape (a window
     * that treats every type alike) is ignored.
     */
    addErrorListener(listener) {
      const target = this.windowLike;
      if (typeof target.addEventListener !== "function") return () => void 0;
      const onError = (event) => {
        const error = readErrorEvent(event);
        if (error !== void 0) listener(error);
      };
      const onRejection = (event) => {
        const error = readRejectionEvent(event);
        if (error !== void 0) listener(error);
      };
      target.addEventListener("error", onError);
      target.addEventListener("unhandledrejection", onRejection);
      return () => {
        target.removeEventListener("error", onError);
        target.removeEventListener("unhandledrejection", onRejection);
      };
    }
    postToParent(data, targetOrigin, opaqueSourceBound = false) {
      if (!targetOrigin || targetOrigin === "*" && !opaqueSourceBound) {
        throw new Error("BrowserHost refused wildcard targetOrigin");
      }
      this.windowLike.parent.postMessage(data, targetOrigin);
    }
  };

  // src/trusted-origin.ts
  var LOCAL_PLAYER_ORIGIN = "http://play.screenrig.localhost:8088";
  var LOCAL_EDGE_PLAYER_ORIGIN = "http://play.screenrig.localhost:18880";
  var DEV_PLAYER_ORIGIN = "http://play.screenrig.localhost:18890";
  var STAGE_PLAYER_ORIGIN = "https://play.stage.screenrig.ai";
  var DASHBOARD_ORIGIN = "https://screenrig.ai";
  var STAGE_DASHBOARD_ORIGIN = "https://stage.screenrig.ai";
  var LOCAL_RELEASE_HOSTNAME = /^r-[a-f0-9]{40}\.apps\.screenrig\.localhost$/;
  var LOCAL_PORTS = [
    { port: "8088", playerOrigin: LOCAL_PLAYER_ORIGIN },
    { port: "18880", playerOrigin: LOCAL_EDGE_PLAYER_ORIGIN },
    { port: "18890", playerOrigin: DEV_PLAYER_ORIGIN }
  ];
  var STAGE_RELEASE_HOSTNAME = /^r-[a-f0-9]{40}\.apps\.stage\.screenrig\.ai$/;
  var NATIVE_PACKAGE_HOSTNAME = /^p-[a-f0-9]{32}\.[a-f0-9]{32}\.offline\.screenrig\.invalid$/;
  function localReleaseParentOrigin(location) {
    if (location.protocol !== "http:" || !LOCAL_RELEASE_HOSTNAME.test(location.hostname)) {
      return void 0;
    }
    for (const { port, playerOrigin } of LOCAL_PORTS) {
      if (location.port === port && location.origin === `http://${location.hostname}:${port}`) {
        return playerOrigin;
      }
    }
    return void 0;
  }
  function isStageReleaseDocument(location) {
    return location.protocol === "https:" && location.port === "" && STAGE_RELEASE_HOSTNAME.test(location.hostname) && location.origin === `https://${location.hostname}`;
  }
  function isNativePackageDocument(location) {
    return location.protocol === "https:" && location.port === "" && NATIVE_PACKAGE_HOSTNAME.test(location.hostname) && location.origin === `https://${location.hostname}`;
  }
  function resolveTrustedPlayerOrigins(location) {
    if (location === void 0) {
      return [DEFAULT_PLAYER_ORIGIN];
    }
    const localParent = localReleaseParentOrigin(location);
    if (localParent !== void 0) {
      return [localParent];
    }
    if (isStageReleaseDocument(location)) {
      return [STAGE_PLAYER_ORIGIN];
    }
    if (isNativePackageDocument(location)) {
      return [DEFAULT_PLAYER_ORIGIN, LOCAL_PLAYER_ORIGIN, LOCAL_EDGE_PLAYER_ORIGIN, STAGE_PLAYER_ORIGIN];
    }
    return [DEFAULT_PLAYER_ORIGIN];
  }
  function resolveDashboardParentOrigin(location) {
    if (location === void 0) {
      return void 0;
    }
    const localParent = localReleaseParentOrigin(location);
    if (localParent !== void 0) {
      return localParent === DEV_PLAYER_ORIGIN ? void 0 : localParent.replace("://play.", "://");
    }
    if (isStageReleaseDocument(location)) {
      return STAGE_DASHBOARD_ORIGIN;
    }
    if (isNativePackageDocument(location) || location.protocol !== "https:") {
      return void 0;
    }
    return DASHBOARD_ORIGIN;
  }
  function resolveTrustedParentPolicy(location) {
    const namedQtPackage = (location == null ? void 0 : location.protocol) === "screenrig-app:" && /^[a-f0-9]{32}\.[a-f0-9]{32}$/.test(location.hostname) && location.port === "" && location.origin === `screenrig-app://${location.hostname}`;
    const dashboard = resolveDashboardParentOrigin(location);
    return {
      origins: [...resolveTrustedPlayerOrigins(location), ...dashboard === void 0 ? [] : [dashboard]],
      allowOpaqueNativeParent: (location == null ? void 0 : location.protocol) === "screenrig-app:" && location.origin === "null",
      ...namedQtPackage ? { nativeParentOrigin: "qrc:" } : {}
    };
  }

  // src/index.ts
  function attachScreenRig(windowLike) {
    if (windowLike.screenrig) {
      return windowLike.screenrig;
    }
    const policy = resolveTrustedParentPolicy(windowLike.location);
    const client = createAttachedScreenRig({
      host: new BrowserHost(windowLike),
      trustedPlayerOrigins: policy.origins
    }, policy.allowOpaqueNativeParent, policy.nativeParentOrigin);
    Object.defineProperty(windowLike, "screenrig", { value: client, enumerable: true, configurable: false, writable: false });
    return client;
  }

  // src/browser.ts
  var candidate = globalThis.window;
  if ((candidate == null ? void 0 : candidate.parent) && typeof candidate.addEventListener === "function") {
    const client = attachScreenRig(candidate);
    const active = () => client.readyState === "active" ? client.context : null;
    if (typeof document !== "undefined") {
      attachCaptureReceiver(window, active);
      attachInputReporter(window, document, active);
    }
    attachLivenessReceiver(candidate, active);
  }
})();
