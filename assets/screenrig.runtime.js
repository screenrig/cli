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
  var USER_AGENT = IN_BROWSER ? window.navigator?.userAgent : "";
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
    const canvas = ownerDocument?.createElement?.("canvas");
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
    return (target && isElementNode(target) ? target?.ownerDocument : target) ?? window.document;
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
        removeEventListeners?.();
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
          onWarn?.(
            "Failed video load",
            currentSrc,
            error
          );
          userOnError?.(error);
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
              onWarn?.(
                "Failed to decode image, trying to render anyway",
                node.dataset.originalSrc || currentSrc,
                error
              );
            }
          }
          onResolve();
        };
        const onError = (error) => {
          onWarn?.(
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
    return fontFamily?.split(",").map((val) => val.trim().replace(/"|'/g, "").toLowerCase()).filter(Boolean);
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
    const { scale = 1, workerUrl, workerNumber = 1 } = options || {};
    const debug = Boolean(options?.debug);
    const features = options?.features ?? true;
    const ownerDocument = node.ownerDocument ?? (IN_BROWSER ? window.document : void 0);
    const ownerWindow = node.ownerDocument?.defaultView ?? (IN_BROWSER ? window : void 0);
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
        requestInit: getDefaultRequestInit(options?.fetch?.bypassingCache),
        placeholderImage: "data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        bypassingCache: false,
        ...options?.fetch
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
      svgDefsElement: ownerDocument?.createElementNS(XMLNS, "defs"),
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
            const { url, result } = event.data;
            if (result) {
              requests.get(url)?.resolve?.(result);
            } else {
              requests.get(url)?.reject?.(new Error(`Error receiving message from worker: ${url}`));
            }
          };
          worker.onmessageerror = (event) => {
            const { url } = event.data;
            requests.get(url)?.reject?.(new Error(`Error receiving message from worker: ${url}`));
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
        context2d?.drawImage(loaded, 0, 0, canvas.width, canvas.height);
      } catch (error) {
        context.log.warn("Failed to drawImage", error);
      }
    };
    drawImage();
    if (context.isEnable("fixSvgXmlDecode")) {
      for (let i = 0; i < drawImageCount; i++) {
        await new Promise((resolve) => {
          setTimeout(() => {
            context2d?.clearRect(0, 0, canvas.width, canvas.height);
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
    try {
      if (iframe?.contentDocument?.documentElement) {
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
    const sandboxWindow = sandbox?.contentWindow;
    if (!sandboxWindow)
      return /* @__PURE__ */ new Map();
    const sandboxDocument = sandboxWindow?.document;
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
      prefixTree.get(prefixs[i])?.forEach((value, name) => diffStyle.set(name, value));
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
    const { ownerWindow, includeStyleProperties, currentParentNodeStyle } = context;
    const clonedStyle = cloned.style;
    const computedStyle = ownerWindow.getComputedStyle(node);
    const defaultStyle = getDefaultStyle(node, null, context);
    currentParentNodeStyle?.forEach((_, key) => {
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
    if (style.get("background-clip")?.[0] === "text") {
      cloned.classList.add("______background-clip--text");
    }
    if (IN_CHROME) {
      if (!style.has("font-kerning"))
        style.set("font-kerning", ["normal", ""]);
      if ((style.get("overflow-x")?.[0] === "hidden" || style.get("overflow-y")?.[0] === "hidden") && style.get("text-overflow")?.[0] === "ellipsis" && node.scrollWidth === node.clientWidth) {
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
      const computedStyle = ownerWindow.getComputedStyle(node, pseudoClass);
      let content = computedStyle.getPropertyValue("content");
      if (!content || content === "none")
        return;
      addWordToFontFamilies?.(content);
      content = content.replace(/(')|(")|(counter\(.+\))/g, "");
      const klasses = [uuid()];
      const defaultStyle = getDefaultStyle(node, pseudoClass, context);
      currentNodeStyle?.forEach((_, key) => {
        defaultStyle.delete(key);
      });
      const style = getDiffStyle(computedStyle, defaultStyle, context.includeStyleProperties);
      style.delete("content");
      style.delete("-webkit-locale");
      if (style.get("background-clip")?.[0] === "text") {
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
    let firstChild = node.firstChild;
    if (isElementNode(node)) {
      if (node.shadowRoot) {
        firstChild = node.shadowRoot?.firstChild;
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
          style.get("overflow-x")?.[0],
          style.get("overflow-y")?.[0]
        ];
        copyScrollbar = overflow.includes("scroll") || (overflow.includes("auto") || overflow.includes("overlay")) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth);
      }
      const textTransform = style.get("text-transform")?.[0];
      const families = splitFontFamily(style.get("font-family")?.[0]);
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
          word.split("").forEach((text) => fontFamily.add(text));
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
      await onCloneEachNode?.(cloned2);
      return cloned2;
    }
    const cloned = node.cloneNode(false);
    await cloneChildNodes(node, cloned, context);
    await onCloneEachNode?.(cloned);
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
          fontFamilies.get(family).forEach((text) => fontTexts.add(text));
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
        ownerDocument?.querySelector(`svg ${query}`)
      );
      if (svgUrl) {
        cloned.setAttribute("href", query);
      }
      if (svgDefsElement?.querySelector(query))
        return [];
      if (definition) {
        svgDefsElement?.appendChild(definition.cloneNode(true));
        return [];
      } else if (svgUrl) {
        return [
          contextFetch(context, {
            url: svgUrl,
            responseType: "text"
          }).then((svgData) => {
            svgDefsElement?.insertAdjacentHTML("beforeend", svgData);
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
      cssRules.filter((cssRule) => isCssFontFaceRule(cssRule) && hasCssUrl(cssRule.style.getPropertyValue("src")) && splitFontFamily(cssRule.style.getPropertyValue("font-family"))?.some((val) => fontFamilies.has(val))).forEach((value) => {
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
      const matches = KEYFRAMES_RE.exec(cssText);
      if (!matches)
        break;
      result.push(matches[0]);
    }
    cssText = cssText.replace(KEYFRAMES_RE, "");
    const IMPORT_RE = /@import[\s\S]*?url\([^)]*\)[\s\S]*?;/gi;
    const UNIFIED_RE = new RegExp(
      // eslint-disable-next-line
      "((\\s*?(?:\\/\\*[\\s\\S]*?\\*\\/)?\\s*?@media[\\s\\S]*?){([\\s\\S]*?)}\\s*?})|(([\\s\\S]*?){([\\s\\S]*?)})",
      "gi"
    );
    while (true) {
      let matches = IMPORT_RE.exec(cssText);
      if (!matches) {
        matches = UNIFIED_RE.exec(cssText);
        if (!matches) {
          break;
        } else {
          IMPORT_RE.lastIndex = UNIFIED_RE.lastIndex;
        }
      } else {
        UNIFIED_RE.lastIndex = IMPORT_RE.lastIndex;
      }
      result.push(matches[0]);
    }
    return result;
  }
  var URL_WITH_FORMAT_RE = /url\([^)]+\)\s*format\((["']?)([^"']+)\1\)/g;
  var FONT_SRC_RE = /src:\s*(?:url\([^)]+\)\s*format\([^)]+\)[,;]\s*)+/g;
  function filterPreferredFormat(str, context) {
    const { font } = context;
    const preferredFormat = font ? font?.preferredFormat : void 0;
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
    await onCloneNode?.(clone);
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
        progress?.(++current, count);
      }
    };
    progress?.(current, count);
    await Promise.all([...Array.from({ length: 4 })].map(runTask));
    log.timeEnd("embed node");
    await onEmbedNode?.(clone);
    const svg = createForeignObjectSvg(clone, context);
    svgDefsElement && svg.insertBefore(svgDefsElement, svg.children[0]);
    svgStyleElement && svg.insertBefore(svgStyleElement, svg.children[0]);
    autoDestruct && destroyContext(context);
    await onCreateForeignObjectSvg?.(svg);
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
    const context = await orCreateContext(node, options);
    const svg = await domToForeignObjectSvg(context);
    const dataUrl = svgToDataUrl(svg, context.isEnable("removeControlCharacter"));
    if (!context.autoDestruct) {
      context.svgStyleElement = createStyleElement(context.ownerDocument);
      context.svgDefsElement = context.ownerDocument?.createElementNS(XMLNS, "defs");
      context.svgStyles.clear();
    }
    const image = createImage(dataUrl, svg.ownerDocument);
    return await imageToCanvas(image, context);
  }

  // src/capture.ts
  /*! Bundled modern-screenshot 4.7.0
  The MIT License (MIT)
  
  Copyright (c) 2021-present wxm
  
  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
  
  The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
  
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
  */
  var CAPTURE_PROTOCOL = "screenrig.capture/1";
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
    return Object.keys(request).length === 5 && request.protocol === CAPTURE_PROTOCOL && request.kind === "capture" && request.primitive_id === context.primitive_id && request.generation === context.generation && request.nonce === context.nonce;
  }
  function attachCaptureReceiver(win, context) {
    let busy = false;
    const listener = (event) => {
      const binding = context();
      if (busy || event.source !== win.parent || event.origin === "null" || event.origin !== binding?.player_origin || !validCaptureRequest(event.data, binding) || event.ports.length !== 1) return;
      const port = event.ports[0];
      busy = true;
      void captureDOM(win.document.documentElement).then(async (canvas) => {
        const current = context();
        if (current?.nonce !== binding.nonce || current.generation !== binding.generation) throw new CaptureUnavailable();
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
  async function captureFrame(frame, signal) {
    const binding = frames.get(frame)?.();
    const child = frame.contentWindow;
    if (!binding || !child || binding.origin === "null" || binding.origin === "*") throw new CaptureUnavailable();
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const finish = (blob) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        channel.port1.close();
        channel.port2.close();
        if (blob) resolve(blob);
        else reject(new CaptureUnavailable());
      };
      const abort = () => finish();
      const timer = setTimeout(abort, CAPTURE_TIMEOUT_MS);
      channel.port1.onmessage = (event) => {
        const current = frames.get(frame)?.();
        const data = event.data;
        if (current?.nonce !== binding.nonce || current.generation !== binding.generation || !frame.isConnected) return finish();
        const blob = data?.blob;
        finish(blob instanceof Blob && blob.type === "image/webp" && blob.size > 0 && blob.size <= CAPTURE_MAX_BYTES ? blob : void 0);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return finish();
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
    const rules = [];
    const visit = (list) => {
      for (const rule of list) {
        if (rule instanceof CSSFontFaceRule && families.has(rule.style.getPropertyValue("font-family").replaceAll(/["']/g, "").toLowerCase())) rules.push(rule);
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
        const url = new URL(match[1], rule.parentStyleSheet?.href ?? document2.baseURI);
        if (url.origin !== document2.location.origin) throw new CaptureUnavailable();
        const response = await fetch(url, { credentials: "same-origin", cache: "force-cache", signal: AbortSignal.timeout(2e3) });
        if (!response.ok) throw new CaptureUnavailable("capture_failed");
        const buffer = await response.arrayBuffer();
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
  var previous = Promise.resolve();
  function captureDOM(root, signal) {
    const result = previous.catch(() => void 0).then(() => capture(root, signal));
    previous = result;
    return result;
  }
  async function capture(root, signal) {
    if (signal?.aborted) throw new CaptureUnavailable();
    const width = root.clientWidth, height = root.clientHeight;
    if (width < 1 || height < 1 || width * height > MAX_PIXELS) throw new CaptureUnavailable("capture_failed");
    const marker = `data-capture-${crypto.randomUUID()}`;
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
      for (const family of style.fontFamily.split(",")) families.add(family.trim().replaceAll(/["']/g, "").toLowerCase());
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
        features: { restoreScrollPosition: true },
        filter: (node) => !videos.has(node) && (!(node instanceof Element) || node.hasAttribute(marker) || visible(node)),
        onCloneNode: (clone) => {
          if (!(clone instanceof Element)) return;
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
      if (failed || signal?.aborted) throw new CaptureUnavailable("capture_failed");
      return canvas;
    } catch (error) {
      throw error instanceof CaptureUnavailable ? error : new CaptureUnavailable("capture_failed");
    } finally {
      for (const node of marked) node.removeAttribute(marker);
      for (const image of placeholders) image.remove();
      if (context) destroyContext(context);
    }
  }

  // src/protocol.ts
  var PROTOCOL = "1";
  var PARENT_HANDSHAKE_PROTOCOL = "screenrig.parent-handshake/1";
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
    "viewport.changed",
    "kv.get",
    "kv.list",
    "kv.set",
    "kv.delete",
    "response.ack",
    "response.problem"
  ];
  var EMPTY_CAPABILITIES = {
    "page.advance": false,
    "kv.read": false,
    "kv.write": false
  };

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
  function parseParentHandshakeOffer(data) {
    if (!isRecord(data) || serializedSize(data) > MAX_MESSAGE_BYTES) {
      throw new SdkValidationError("invalid_handshake", "Parent handshake must be a bounded object");
    }
    if (!hasExactKeys(data, ["protocol", "kind", "challenge"])) {
      throw new SdkValidationError("invalid_handshake", "Parent handshake has an invalid shape");
    }
    if (data.protocol !== PARENT_HANDSHAKE_PROTOCOL || data.kind !== "parent.handshake" || typeof data.challenge !== "string" || !NONCE_RE.test(data.challenge)) {
      throw new SdkValidationError("invalid_handshake", "Parent handshake is invalid");
    }
    return { protocol: PARENT_HANDSHAKE_PROTOCOL, kind: "parent.handshake", challenge: data.challenge };
  }
  function hasExactKeys(value, keys) {
    return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
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
    if (Object.prototype.hasOwnProperty.call(data, "__proto__") || Object.prototype.hasOwnProperty.call(data, "constructor")) {
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
    if (!isRecord(payload)) {
      throw new SdkValidationError("invalid_payload", "payload must be an object");
    }
    const allowed = /* @__PURE__ */ new Set(["protocol", "message_id", "kind", "primitive_id", "payload"]);
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) {
        throw new SdkValidationError("invalid_shape", `Unexpected field ${key}`);
      }
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
  function parseCapabilities(value) {
    if (!isRecord(value)) {
      throw new SdkValidationError("invalid_context", "capabilities must be an object");
    }
    return {
      "page.advance": value["page.advance"] === true,
      "kv.read": value["kv.read"] === true,
      "kv.write": value["kv.write"] === true
    };
  }
  function parseContextPayload(payload, expectedOrigin) {
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
    return {
      application_id,
      release_id,
      primitive_id,
      generation,
      nonce,
      player_origin,
      capabilities: parseCapabilities(payload.capabilities),
      viewport: parseSize(payload.viewport, "viewport"),
      primitive: parseSize(payload.primitive, "primitive"),
      screen_id: typeof payload.screen_id === "string" && ID_RE.test(payload.screen_id) ? payload.screen_id : void 0
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
    return {
      "page.advance": offered["page.advance"] === true,
      "kv.read": offered["kv.read"] === true,
      "kv.write": offered["kv.write"] === true
    };
  }

  // src/screenrig.ts
  function randomId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `msg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  function randomIdempotencyKey() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }
  function base64(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index] ?? 0;
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      const word = first << 16 | (second ?? 0) << 8 | (third ?? 0);
      output += alphabet[word >>> 18 & 63] ?? "";
      output += alphabet[word >>> 12 & 63] ?? "";
      output += second === void 0 ? "=" : alphabet[word >>> 6 & 63] ?? "";
      output += third === void 0 ? "=" : alphabet[word & 63] ?? "";
    }
    return output;
  }
  var ScreenRigClient = class {
    constructor(options, allowOpaqueNativeParent = false, nativeParentOrigin) {
      this.nativeParentOrigin = nativeParentOrigin;
      this.host = options.host;
      this.trustedPlayerOrigins = options.trustedPlayerOrigins ?? [options.trustedPlayerOrigin ?? DEFAULT_PLAYER_ORIGIN];
      if (this.trustedPlayerOrigins.length === 0 || this.trustedPlayerOrigins.some((origin) => !origin || origin === "*")) {
        throw new SdkValidationError("wildcard_origin", "Wildcard origins are not allowed");
      }
      this.idFactory = options.idFactory ?? randomId;
      this.ackTimeoutMs = options.ackTimeoutMs ?? 1e4;
      this.allowOpaqueNativeParent = allowOpaqueNativeParent;
      this.unsubscribe = this.host.addMessageListener((event) => this.onMessage(event));
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
    unsubscribe;
    advanced = false;
    reports = 0;
    parentOrigin = null;
    targetOrigin = null;
    handshakeChallenge = null;
    opaqueSourceBound = false;
    kv = {
      get: (key) => this.kvGet(key),
      list: () => this.kvList(),
      set: (key, value, options) => this.kvSet(key, value, options),
      delete: (key, expectedRevision, options) => this.kvDelete(key, expectedRevision, options)
    };
    destroy() {
      this.destroyed = true;
      this.unsubscribe();
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
          const viewport = message.payload.viewport;
          const primitive = message.payload.primitive;
          if (!viewport || !primitive) {
            return;
          }
          this.context = { ...this.context, viewport, primitive };
          for (const handler of this.resizeHandlers) {
            handler({ viewport, primitive });
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
      const context = parseContextPayload(message.payload, this.parentOrigin);
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
      for (const handler of this.capabilityHandlers) {
        handler(this.capabilities);
      }
    }
    post(message, wait) {
      if (this.targetOrigin === null || this.handshakeChallenge === null) {
        throw new SdkValidationError("inert", "SDK has not bound a parent handshake");
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
    async kvList() {
      const context = this.requireCapability("kv.read");
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.list", primitive_id: context.primitive_id, payload: { generation: context.generation, nonce: context.nonce } }, true);
    }
    async kvSet(key, value, options = {}) {
      const context = this.requireCapability("kv.write");
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const payload = {
        key: this.requireKey(key),
        value_base64: base64(bytes),
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
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new SdkValidationError("invalid_revision", "expectedRevision must be a non-negative integer");
      }
      const payload = {
        key: this.requireKey(key),
        expected_revision: expectedRevision,
        idempotency_key: options.idempotencyKey ?? randomIdempotencyKey(),
        generation: context.generation,
        nonce: context.nonce
      };
      return this.post({ protocol: PROTOCOL, message_id: this.idFactory(), kind: "kv.delete", primitive_id: context.primitive_id, payload: { ...payload } }, true);
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
    postToParent(data, targetOrigin, opaqueSourceBound = false) {
      if (!targetOrigin || targetOrigin === "*" && !opaqueSourceBound) {
        throw new Error("BrowserHost refused wildcard targetOrigin");
      }
      this.windowLike.parent.postMessage(data, targetOrigin);
    }
  };

  // src/trusted-origin.ts
  var LOCAL_PLAYER_ORIGIN = "http://play.screenrig.localhost:8088";
  var LOCAL_RELEASE_HOSTNAME = /^r-[a-f0-9]{40}\.apps\.screenrig\.localhost$/;
  var NATIVE_PACKAGE_HOSTNAME = /^p-[a-f0-9]{32}\.[a-f0-9]{32}\.offline\.screenrig\.invalid$/;
  function isLocalReleaseDocument(location) {
    return location.protocol === "http:" && location.port === "8088" && LOCAL_RELEASE_HOSTNAME.test(location.hostname) && location.origin === `http://${location.hostname}:8088`;
  }
  function isNativePackageDocument(location) {
    return location.protocol === "https:" && location.port === "" && NATIVE_PACKAGE_HOSTNAME.test(location.hostname) && location.origin === `https://${location.hostname}`;
  }
  function resolveTrustedPlayerOrigins(location) {
    if (location === void 0) {
      return [DEFAULT_PLAYER_ORIGIN];
    }
    if (isLocalReleaseDocument(location)) {
      return [LOCAL_PLAYER_ORIGIN];
    }
    if (isNativePackageDocument(location)) {
      return [DEFAULT_PLAYER_ORIGIN, LOCAL_PLAYER_ORIGIN];
    }
    return [DEFAULT_PLAYER_ORIGIN];
  }
  function resolveTrustedParentPolicy(location) {
    const namedQtPackage = location?.protocol === "screenrig-app:" && /^[a-f0-9]{32}\.[a-f0-9]{32}$/.test(location.hostname) && location.port === "" && location.origin === `screenrig-app://${location.hostname}`;
    return {
      origins: resolveTrustedPlayerOrigins(location),
      allowOpaqueNativeParent: location?.protocol === "screenrig-app:" && location.origin === "null",
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
  if (candidate?.parent && typeof candidate.addEventListener === "function") {
    const client = attachScreenRig(candidate);
    if (typeof document !== "undefined") attachCaptureReceiver(window, () => client.readyState === "active" ? client.context : null);
  }
})();
